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
  const payer = anchor.web3.Keypair.generate(); // A：货主
  const partyB = anchor.web3.Keypair.generate(); // B：发货货代
  const partyC = anchor.web3.Keypair.generate(); // C：船司
  const partyD = anchor.web3.Keypair.generate(); // D：目的港代理
  const oracle = anchor.web3.Keypair.generate(); // 预言机
  const unauthorized = anchor.web3.Keypair.generate(); // 未授权用户

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
    // 给会签名发交易的账户空投（payer / oracle / unauthorized）
    await airdrop(payer.publicKey);
    await airdrop(oracle.publicKey);
    await airdrop(unauthorized.publicKey);

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
      BigInt(totalAmount.mul(new anchor.BN(10)).toString()) // 10x total amount for multiple tests
    );
  });

  it("create_order: 正常创建订单并校验字段", async () => {
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

  it("create_order: 比例和不为 100 时应失败", async () => {
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

  it("create_order: 同一个 orderId 重复创建应失败（PDA 已存在）", async () => {
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

      assert.fail("预期第二次 create_order 失败，但实际成功");
    } catch (err: any) {
      const msg = String(err);
      assert.isTrue(
        msg.includes("already in use") || msg.includes("custom program error"),
        `期望报错为地址已存在/初始化失败，实际: ${msg}`
      );
    }
  });

  it("完整流程测试: create_order → init_escrow → deposit → release_by_oracle", async () => {
    const orderId = new anchor.BN(2001);
    const ratioB = 30;
    const ratioC = 50;
    const ratioD = 20;

    const [orderPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("order"), orderId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [escrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), orderId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // Step 1: 创建订单
    await program.methods
      .createOrder(
        orderId,
        partyB.publicKey,
        partyC.publicKey,
        partyD.publicKey,
        totalAmount,
        ratioB,
        ratioC,
        ratioD
      )
      .accountsPartial({
        payer: payer.publicKey,
        orderAccount: orderPda,
        oracle: oracle.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    // Step 2: 初始化 escrow 账户
    await program.methods
      .initEscrow(orderId)
      .accountsPartial({
        payer: payer.publicKey,
        orderAccount: orderPda,
        escrowTokenAccount: escrowPda,
        tokenMint: usdcMint,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    // 记录 deposit 前的余额，后面要验证
    const payerBefore = await getAccount(provider.connection, payerTokenAccount);
    const bBefore = await getAccount(provider.connection, partyBTokenAccount);
    const cBefore = await getAccount(provider.connection, partyCTokenAccount);
    const dBefore = await getAccount(provider.connection, partyDTokenAccount);

    // Step 3: deposit
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

    // 验证订单状态变成 Locked
    let order = await program.account.orderAccount.fetch(orderPda);
    assert.deepEqual(order.status, { locked: {} });

    // 验证 escrow 账户余额
    const escrowAfterDeposit = await getAccount(provider.connection, escrowPda);
    assert.equal(escrowAfterDeposit.amount.toString(), totalAmount.toString());

    // 验证 payer 余额减少
    const payerAfterDeposit = await getAccount(provider.connection, payerTokenAccount);
    assert.equal(
      BigInt(payerAfterDeposit.amount.toString()),
      BigInt(payerBefore.amount.toString()) - BigInt(totalAmount.toString())
    );

    // Step 4: 预言机 release
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

    // 验证订单状态变成 Released
    order = await program.account.orderAccount.fetch(orderPda);
    assert.deepEqual(order.status, { released: {} });

    // 验证 B, C, D 各自收到对应金额
    const bAfter = await getAccount(provider.connection, partyBTokenAccount);
    const cAfter = await getAccount(provider.connection, partyCTokenAccount);
    const dAfter = await getAccount(provider.connection, partyDTokenAccount);

    const expectedB = (totalAmount.toNumber() * ratioB) / 100;
    const expectedC = (totalAmount.toNumber() * ratioC) / 100;
    const expectedD = totalAmount.toNumber() - expectedB - expectedC;

    assert.equal(
      Number(bAfter.amount) - Number(bBefore.amount),
      expectedB
    );
    assert.equal(
      Number(cAfter.amount) - Number(cBefore.amount),
      expectedC
    );
    assert.equal(
      Number(dAfter.amount) - Number(dBefore.amount),
      expectedD
    );
  });

  it("deposit: 非 payer 尝试 deposit 应失败", async () => {
    const orderId = new anchor.BN(2002);

    const [orderPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("order"), orderId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // 创建订单并初始化 escrow
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

    const [escrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), orderId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    await program.methods
      .initEscrow(orderId)
      .accountsPartial({
        payer: payer.publicKey,
        orderAccount: orderPda,
        escrowTokenAccount: escrowPda,
        tokenMint: usdcMint,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    // 未授权用户尝试 deposit
    try {
      await program.methods
        .deposit(totalAmount)
        .accountsPartial({
          payer: unauthorized.publicKey,
          orderAccount: orderPda,
          payerTokenAccount,
          escrowTokenAccount: escrowPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([unauthorized])
        .rpc();

      assert.fail("预期 deposit 失败（非 payer）");
    } catch (err: any) {
      const msg = String(err);
      assert.isTrue(
        msg.includes("UnauthorizedPayer") || msg.includes("6003"),
        `期望错误包含 UnauthorizedPayer，实际: ${msg}`
      );
    }
  });

  it("deposit: 金额不匹配应失败", async () => {
    const orderId = new anchor.BN(2003);

    const [orderPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("order"), orderId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // 创建订单并初始化 escrow
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

    const [escrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), orderId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    await program.methods
      .initEscrow(orderId)
      .accountsPartial({
        payer: payer.publicKey,
        orderAccount: orderPda,
        escrowTokenAccount: escrowPda,
        tokenMint: usdcMint,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    // 尝试 deposit 错误金额
    try {
      await program.methods
        .deposit(new anchor.BN(100)) // 金额不匹配
        .accountsPartial({
          payer: payer.publicKey,
          orderAccount: orderPda,
          payerTokenAccount,
          escrowTokenAccount: escrowPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([payer])
        .rpc();

      assert.fail("预期 deposit 失败（金额不匹配）");
    } catch (err: any) {
      const msg = String(err);
      assert.isTrue(
        msg.includes("AmountMismatch") || msg.includes("6002"),
        `期望错误包含 AmountMismatch，实际: ${msg}`
      );
    }
  });

  it("release_by_oracle: 非预言机尝试调用应失败", async () => {
    const orderId = new anchor.BN(3001);

    const [orderPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("order"), orderId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // 创建订单, 初始化 escrow 并 deposit
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

    const [escrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), orderId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    await program.methods
      .initEscrow(orderId)
      .accountsPartial({
        payer: payer.publicKey,
        orderAccount: orderPda,
        escrowTokenAccount: escrowPda,
        tokenMint: usdcMint,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

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

    // 未授权用户尝试 release
    try {
      await program.methods
        .releaseByOracle()
        .accountsPartial({
          oracle: unauthorized.publicKey,
          orderAccount: orderPda,
          escrowTokenAccount: escrowPda,
          partyBTokenAccount,
          partyCTokenAccount,
          partyDTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([unauthorized])
        .rpc();

      assert.fail("预期 release_by_oracle 失败（非预言机）");
    } catch (err: any) {
      const msg = String(err);
      assert.isTrue(
        msg.includes("UnauthorizedOracle") || msg.includes("6002"),
        `期望错误包含 UnauthorizedOracle，实际: ${msg}`
      );
    }
  });
});
