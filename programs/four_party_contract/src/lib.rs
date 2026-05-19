use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("E6sUfhvFwtQE71GYsgHPPY28XbfGWASCqXs1FJWW7eyg");


#[program]
pub mod multi_party_escrow {
    use super::*;

    // 1. 创建订单（A 调用）
    // 初始化一个订单托管账户，记录参与方和分配比例
    pub fn create_order(
        ctx: Context<CreateOrder>,
        order_id: u64,       // 订单唯一编号（通常由前端生成或链上自增）
        party_b: Pubkey,     // 发货货代地址
        party_c: Pubkey,     // 船司地址
        party_d: Pubkey,     // 目的港代理地址
        total_amount: u64,   // 订单总金额（USDC 最小单位）
        ratio_b: u8,         // B 的百分比（例如 20 表示 20%）
        ratio_c: u8,         // C 的百分比
        ratio_d: u8,         // D 的百分比
    ) -> Result<()> {
        // 确保比例之和为 100%
        require!(
            ratio_b + ratio_c + ratio_d == 100,
            ErrorCode::InvalidRatio
        );

        let order = &mut ctx.accounts.order_account;
        order.order_id = order_id;
        order.payer = ctx.accounts.payer.key();          // A（货主）
        order.party_b = party_b;
        order.party_c = party_c;
        order.party_d = party_d;
        order.total_amount = total_amount;
        order.ratio_b = ratio_b;
        order.ratio_c = ratio_c;
        order.ratio_d = ratio_d;
        order.oracle = ctx.accounts.oracle.key();        // 预言机公钥（在初始化时传入，防止篡改）
        order.status = OrderStatus::Created;             // 初始状态：已创建
        order.bump = ctx.bumps.order_account; // 存储 PDA bump，便于后续签名

        Ok(())
    }

    // 0. 初始化 escrow 账户（A 调用，创建订单后调用）
    // 在链上创建托管代币账户
    pub fn init_escrow(_ctx: Context<InitEscrow>, _order_id: u64) -> Result<()> {
        // Anchor 已经通过 #[account(init)] 自动为我们初始化了 Token 账户！
        // 所以我们不需要手动调用 token::initialize_account
        Ok(())
    }

    // 2. 充值并锁定资金（A 调用）
    // A 将 USDC 转入合约托管的代币账户，同时锁定订单
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        let order = &mut ctx.accounts.order_account;

        // 仅允许在 Created 状态下充值
        require!(order.status == OrderStatus::Created, ErrorCode::InvalidOrderStatus);

        // 充值金额必须与创建时声明的总金额一致，保证订单金额不可篡改
        require!(amount == order.total_amount, ErrorCode::AmountMismatch);

        // 将 A 的 USDC 从 A 的 ATA 转移到托管 PDA 的 ATA
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.payer_token_account.to_account_info(),
                    to: ctx.accounts.escrow_token_account.to_account_info(),
                    authority: ctx.accounts.payer.to_account_info(),
                },
            ),
            amount,
        )?;

        // 更新订单状态为已锁定
        order.status = OrderStatus::Locked;

        Ok(())
    }

    // 3. 预言机触发分账放款（仅预言机可调用）
    // 验证调用者为授权预言机后，按比例将资金转给 B、C、D
    pub fn release_by_oracle(ctx: Context<Release>) -> Result<()> {
        let order = &ctx.accounts.order_account;

        // 1) 检查调用者是授权的预言机
        require!(
            ctx.accounts.oracle.key() == order.oracle,
            ErrorCode::UnauthorizedOracle
        );

        // 2) 订单必须处于 Locked 状态
        require!(order.status == OrderStatus::Locked, ErrorCode::InvalidOrderStatus);

        // 获取托管代币账户的余额（应当为 total_amount）
        let escrow_balance = ctx.accounts.escrow_token_account.amount;
        require!(
            escrow_balance >= order.total_amount,
            ErrorCode::InsufficientEscrowBalance
        );

        // 分别计算 B、C、D 应得的金额（向下取整，余数留在托管账户或转给指定方）
        let amount_b = order
            .total_amount
            .checked_mul(order.ratio_b as u64)
            .unwrap()
            .checked_div(100)
            .unwrap();
        let amount_c = order
            .total_amount
            .checked_mul(order.ratio_c as u64)
            .unwrap()
            .checked_div(100)
            .unwrap();
        let amount_d = order
            .total_amount
            .checked_sub(amount_b)
            .unwrap()
            .checked_sub(amount_c)
            .unwrap(); // 避免舍入误差，让 D 接收剩余全部

        // 获取托管 PDA 的签名种子
        let order_id_bytes = order.order_id.to_le_bytes();
        let seeds: &[&[u8]] = &[
            b"order".as_ref(),
            order_id_bytes.as_ref(),
            &[order.bump],
        ];
        let signer = &[&seeds[..]];

        // 转账给 B
        if amount_b > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.escrow_token_account.to_account_info(),
                        to: ctx.accounts.party_b_token_account.to_account_info(),
                        authority: ctx.accounts.order_account.to_account_info(),
                    },
                    signer,
                ),
                amount_b,
            )?;
        }
        // 转账给 C
        if amount_c > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.escrow_token_account.to_account_info(),
                        to: ctx.accounts.party_c_token_account.to_account_info(),
                        authority: ctx.accounts.order_account.to_account_info(),
                    },
                    signer,
                ),
                amount_c,
            )?;
        }
        // 转账给 D
        if amount_d > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.escrow_token_account.to_account_info(),
                        to: ctx.accounts.party_d_token_account.to_account_info(),
                        authority: ctx.accounts.order_account.to_account_info(),
                    },
                    signer,
                ),
                amount_d,
            )?;
        }

        // 更新订单状态为已释放
        let order = &mut ctx.accounts.order_account;
        order.status = OrderStatus::Released;

        Ok(())
    }

    // （可选）退款功能：仅在 Created 状态且 A 还未充值前，A 可取消订单
    // 或者 Locked 状态下可由预言机触发退款（如货物异常），这里省略
}

// --------------------- 账户结构 ---------------------

#[derive(Accounts)]
#[instruction(order_id: u64)]
pub struct CreateOrder<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,                   // A（货主），支付创建费用

    /// 订单账户，使用 PDA 存储订单数据
    /// seeds = ["order", order_id.to_le_bytes()]
    #[account(
        init,
        payer = payer,
        space = 8 + std::mem::size_of::<OrderAccount>(),
        seeds = [b"order", order_id.to_le_bytes().as_ref()],
        bump
    )]
    pub order_account: Account<'info, OrderAccount>,

    /// 预言机公钥，需在创建时传入，防止后续被篡改
    /// 此处仅作只读记录，不要求签名
    /// CHECK: 仅存储地址，不做账户验证
    pub oracle: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(order_id: u64)]
pub struct InitEscrow<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,                   // A（货主），支付创建费用

    // 订单账户
    #[account(
        seeds = [b"order", order_id.to_le_bytes().as_ref()],
        bump = order_account.bump,
    )]
    pub order_account: Account<'info, OrderAccount>,

    // 托管 PDA 的代币账户
    #[account(
        init,
        payer = payer,
        seeds = [b"escrow", order_id.to_le_bytes().as_ref()],
        bump,
        token::mint = token_mint,
        token::authority = order_account,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    /// USDC mint (CHECK: This is safe since we're using it to initialize the token account with #[account(init, token::mint)] which already validates it)
    pub token_mint: AccountInfo<'info>,

    pub rent: Sysvar<'info, Rent>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,                   // A

    //订单账户，需验证 payer 与订单记录的 payer 一致
    #[account(
        mut,
        seeds = [b"order", &order_account.order_id.to_le_bytes()],
        bump = order_account.bump,
        constraint = payer.key() == order_account.payer @ ErrorCode::UnauthorizedPayer
    )]
    pub order_account: Account<'info, OrderAccount>,

    // A 的 USDC ATA（代币来源）
    #[account(mut, constraint = payer_token_account.owner == payer.key())]
    pub payer_token_account: Account<'info, TokenAccount>,

    // 托管 PDA 的代币账户，用于锁定资金
    // 需要在 deposit 之前由客户端创建好，并授权给 order_account PDA
    #[account(
        mut,
        seeds = [b"escrow", &order_account.order_id.to_le_bytes()],
        bump,
        token::mint = payer_token_account.mint,   // 确保 USDC 代币种类一致
        token::authority = order_account          // 授权给订单 PDA
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    // 预言机签名者，必须是订单中存储的 oracle 公钥
    pub oracle: Signer<'info>,

    // 订单账户
    #[account(
        mut,
        seeds = [b"order", &order_account.order_id.to_le_bytes()],
        bump = order_account.bump,
    )]
    pub order_account: Account<'info, OrderAccount>,

    // 托管代币账户
    #[account(
        mut,
        seeds = [b"escrow", &order_account.order_id.to_le_bytes()],
        bump,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    // B 的 USDC ATA
    #[account(mut, constraint = party_b_token_account.owner == order_account.party_b)]
    pub party_b_token_account: Account<'info, TokenAccount>,

    // C 的 USDC ATA
    #[account(mut, constraint = party_c_token_account.owner == order_account.party_c)]
    pub party_c_token_account: Account<'info, TokenAccount>,

    // D 的 USDC ATA
    #[account(mut, constraint = party_d_token_account.owner == order_account.party_d)]
    pub party_d_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// --------------------- 数据存储 ---------------------

#[account]
pub struct OrderAccount {
    pub order_id: u64,          // 订单编号
    pub payer: Pubkey,          // A 货主
    pub party_b: Pubkey,        // 发货货代
    pub party_c: Pubkey,        // 船司
    pub party_d: Pubkey,        // 目的港代理
    pub total_amount: u64,      // 订单总金额（最小单位）
    pub ratio_b: u8,            // B 分成百分比
    pub ratio_c: u8,            // C 分成百分比
    pub ratio_d: u8,            // D 分成百分比
    pub oracle: Pubkey,         // 授权预言机公钥
    pub status: OrderStatus,    // 订单状态
    pub bump: u8,               // PDA bump
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum OrderStatus {
    Created,   // 已创建，等待充值
    Locked,    // 资金已锁定，等待预言机释放
    Released,  // 资金已释放给各方
    Refunded,  // （预留）已退款
}

// --------------------- 错误码 ---------------------

#[error_code]
pub enum ErrorCode {
    #[msg("分配比例之和必须等于 100")]
    InvalidRatio,
    #[msg("订单状态无效")]
    InvalidOrderStatus,
    #[msg("充值金额与订单总金额不一致")]
    AmountMismatch,
    #[msg("只有订单创建者才能充值")]
    UnauthorizedPayer,
    #[msg("签名者不是授权的预言机")]
    UnauthorizedOracle,
    #[msg("托管账户余额不足")]
    InsufficientEscrowBalance,
}
