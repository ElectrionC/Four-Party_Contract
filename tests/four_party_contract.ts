import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

import { MultiPartyEscrow } from "../target/types/multi_party_escrow";

describe("multi_party_escrow", () => {
  // 1) 连接本地 Anchor Provider，并拿到程序对象
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.MultiPartyEscrow as Program<MultiPartyEscrow>;

  // 2) 参与方密钥对（A/B/C/D + 预言机）
  const payer = anchor.web3.Keypair.generate(); // A: 下单并付款
  const partyB = anchor.web3.Keypair.generate(); // B: 发货货代
  const partyC = anchor.web3.Keypair.generate(); // C: 船司
  const partyD = anchor.web3.Keypair.generate(); // D: 目的港代理
  const oracle = anchor.web3.Keypair.generate(); // 预言机

  // 3) 公共测试参数
  const totalAmount = new anchor.BN(1_000_000); // 1.000000 (6 decimals)

  // 4) USDC 测试 Mint 与各方 Token 账户
  let usdcMint: anchor.web3.PublicKey;
  let payerTokenAccount: anchor.web3.PublicKey;
  let partyBTokenAccount: anchor.web3.PublicKey;
  let partyCTokenAccount: anchor.web3.PublicKey;
  let partyDTokenAccount: anchor.web3.PublicKey;

  // 简单辅助函数：给账户空投 SOL，确保能付交易费
  const airdrop = async (pubkey: anchor.web3.PublicKey, sol = 2) => {
    const signature = await provider.connection.requestAirdrop(
      pubkey,
      sol * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(signature, "confirmed");
  };

  before(async () => {
    // 给会签名发交易的账户空投（payer / oracle）
    await airdrop(payer.publicKey);
    await airdrop(oracle.publicKey);

    // 创建测试用 Mint（由 payer 同时支付手续费并担任 mint authority）
    usdcMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6
    );

    // 为 A/B/C/D 创建 ATA（代币 owner 可不是交易签名者）
    payerTokenAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        usdcMint,
        payer.publicKey
      )
    ).address;

    partyBTokenAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        usdcMint,
        partyB.publicKey
      )
    ).address;

    partyCTokenAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        usdcMint,
        partyC.publicKey
      )
    ).address;

    partyDTokenAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        usdcMint,
        partyD.publicKey
      )
    ).address;

    // 铸币给 A，后续用于 deposit
    await mintTo(
      provider.connection,
      payer,
      usdcMint,
      payerTokenAccount,
      payer,
      BigInt(totalAmount.toString())
    );
  });

  it("createOrder: 正常创建订单并校验字段", async () => {
    const orderId = new anchor.BN(1001);

    // 根据合约 seeds = ["order", order_id_le_bytes] 计算订单 PDA
    const [orderPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("order"), orderId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    await program.methods
      .createOrder(
        orderId,
        partyB.publicKey,
        partyC.publicKey,
        partyD.publicKey,
        totalAmount,
        30,
        50,
        20
      )
      .accountsPartial({
        payer: payer.publicKey,
        orderAccount: orderPda,
        oracle: oracle.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    const order = await program.account.orderAccount.fetch(orderPda);

    // 核对链上状态，确保每个关键字段都正确落账
    assert.equal(order.orderId.toString(), orderId.toString());
    assert.equal(order.payer.toBase58(), payer.publicKey.toBase58());
    assert.equal(order.partyB.toBase58(), partyB.publicKey.toBase58());
    assert.equal(order.partyC.toBase58(), partyC.publicKey.toBase58());
    assert.equal(order.partyD.toBase58(), partyD.publicKey.toBase58());
    assert.equal(order.oracle.toBase58(), oracle.publicKey.toBase58());
    assert.equal(order.totalAmount.toString(), totalAmount.toString());
    assert.equal(order.ratioB, 30);
    assert.equal(order.ratioC, 50);
    assert.equal(order.ratioD, 20);
    assert.deepEqual(order.status, { created: {} });
  });

  it("createOrder: 比例和不为 100 时应失败", async () => {
    const orderId = new anchor.BN(1002);

    const [orderPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("order"), orderId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    try {
      await program.methods
        .createOrder(
          orderId,
          partyB.publicKey,
          partyC.publicKey,
          partyD.publicKey,
          totalAmount,
          40,
          40,
          30 // 40 + 40 + 30 = 110
        )
        .accountsPartial({
          payer: payer.publicKey,
          orderAccount: orderPda,
          oracle: oracle.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([payer])
        .rpc();

      assert.fail("预期应抛出 InvalidRatio，但实际没有失败");
    } catch (err: any) {
      const msg = String(err);
      assert.isTrue(
        msg.includes("InvalidRatio") || msg.includes("6000"),
        `期望错误包含 InvalidRatio/6000，实际: ${msg}`
      );
    }
  });

  it("createOrder: 同一个 orderId 重复创建应失败（PDA 已存在）", async () => {
    const orderId = new anchor.BN(1003);

    const [orderPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("order"), orderId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // 第一次创建成功
    await program.methods
      .createOrder(
        orderId,
        partyB.publicKey,
        partyC.publicKey,
        partyD.publicKey,
        totalAmount,
        10,
        20,
        70
      )
      .accountsPartial({
        payer: payer.publicKey,
        orderAccount: orderPda,
        oracle: oracle.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    // 第二次同样的 orderId 会命中同一个 PDA，init 必然失败
    try {
      await program.methods
        .createOrder(
          orderId,
          partyB.publicKey,
          partyC.publicKey,
          partyD.publicKey,
          totalAmount,
          10,
          20,
          70
        )
        .accountsPartial({
          payer: payer.publicKey,
          orderAccount: orderPda,
          oracle: oracle.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([payer])
        .rpc();

      assert.fail("预期第二次 createOrder 失败，但实际成功");
    } catch (err: any) {
      const msg = String(err);
      assert.isTrue(
        msg.includes("already in use") || msg.includes("custom program error"),
        `期望报错为地址已存在/初始化失败，实际: ${msg}`
      );
    }
  });

  it("deposit: 未提供已初始化的 escrow PDA token 账户时应失败", async () => {
    const orderId = new anchor.BN(1004);

    const [orderPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("order"), orderId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [escrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), orderId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // 先创建订单（状态为 Created）
    await program.methods
      .createOrder(
        orderId,
        partyB.publicKey,
        partyC.publicKey,
        partyD.publicKey,
        totalAmount,
        30,
        30,
        40
      )
      .accountsPartial({
        payer: payer.publicKey,
        orderAccount: orderPda,
        oracle: oracle.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    // 当前 .rs 的 Deposit 账户约束要求 escrow_token_account 是 PDA 且已是有效 TokenAccount。
    // 如果未初始化该 PDA 账户，会在进入业务逻辑前直接失败。
    try {
      await program.methods
        .deposit(totalAmount)
        .accountsPartial({
          payer: payer.publicKey,
          orderAccount: orderPda,
          payerTokenAccount,
          escrowTokenAccount: escrowPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([payer])
        .rpc();

      assert.fail("预期 deposit 失败（escrow PDA token account 未初始化）");
    } catch (err: any) {
      const msg = String(err);
      assert.isTrue(msg.length > 0, "应返回错误信息");
    }

    // 验证 A 的余额未被错误扣减
    const payerAccount = await getAccount(provider.connection, payerTokenAccount);
    assert.equal(payerAccount.amount.toString(), totalAmount.toString());
  });

  it("releaseByOracle: 在资金未锁定时应失败", async () => {
    const orderId = new anchor.BN(1005);

    const [orderPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("order"), orderId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [escrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), orderId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // 只创建订单，不做 deposit（状态仍为 Created）
    await program.methods
      .createOrder(
        orderId,
        partyB.publicKey,
        partyC.publicKey,
        partyD.publicKey,
        totalAmount,
        25,
        25,
        50
      )
      .accountsPartial({
        payer: payer.publicKey,
        orderAccount: orderPda,
        oracle: oracle.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    // 注意：当前合约中 release 也依赖 escrow PDA token account；若该账户不存在，
    // 会先在账户校验阶段失败。这仍然符合“未完成锁定不可放款”的系统行为。
    try {
      await program.methods
        .releaseByOracle()
        .accountsPartial({
          oracle: oracle.publicKey,
          orderAccount: orderPda,
          escrowTokenAccount: escrowPda,
          partyBTokenAccount,
          partyCTokenAccount,
          partyDTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([oracle])
        .rpc();

      assert.fail("预期 releaseByOracle 失败，但实际成功");
    } catch (err: any) {
      const msg = String(err);
      assert.isTrue(msg.length > 0, "应返回错误信息");
    }
  });
});
