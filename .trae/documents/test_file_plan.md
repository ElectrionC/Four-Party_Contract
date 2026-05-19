# 四方托管合约测试文件规划

## 一、智能合约理解

### 合约功能概述
这是一个基于 Solana Anchor 框架的四方托管智能合约，用于物流场景中的资金分账管理：
- **A（货主）**：创建订单、充值锁定资金
- **B（发货货代）**：接收分成
- **C（船司）**：接收分成
- **D（目的港代理）**：接收分成
- **预言机**：触发分账释放

### 核心指令
| 指令 | 功能 |
|------|------|
| `create_order` | 创建订单，设置参与方、分成比例、预言机 |
| `deposit` | 充值并锁定资金 |
| `release_by_oracle` | 预言机触发分账放款 |

### 状态机
```
Created → Locked → Released
     ↓
  (可选退款)
```

---

## 二、现有测试分析

### 已覆盖的测试用例
1. ✅ `createOrder` 正常创建订单
2. ✅ `createOrder` 比例和不为 100 时失败
3. ✅ `createOrder` 重复 orderId 失败
4. ✅ `deposit` 未初始化 escrow 账户失败
5. ✅ `releaseByOracle` 在资金未锁定时失败

### 缺失的关键测试

| 模块 | 缺失测试 |
|------|----------|
| **deposit** | 完整 deposit 成功流程（需先创建 escrow token account） |
| **deposit** | 非 payer 尝试 deposit 失败 |
| **deposit** | 金额不匹配失败 |
| **deposit** | 重复 deposit 失败 |
| **release_by_oracle** | 完整分账成功流程 |
| **release_by_oracle** | 非预言机尝试 release 失败 |
| **release_by_oracle** | 金额比例计算验证 |

---

## 三、测试实施计划

### 步骤 1：完善辅助函数
- 添加创建 escrow token account 的辅助函数
- 复用现有的 airdrop 函数

### 步骤 2：补充 deposit 相关测试
1. **正常 deposit 测试**
   - 创建订单
   - 创建 escrow token account
   - 执行 deposit
   - 验证订单状态变为 Locked
   - 验证 escrow 账户余额

2. **权限验证**（非 payer 无法 deposit）

3. **金额验证**（金额不匹配失败）

4. **重复 deposit 验证**

### 步骤 3：补充 release_by_oracle 相关测试
1. **完整分账流程测试**
   - 创建订单 → deposit → 预言机 release
   - 验证 B/C/D 各自收到的金额
   - 验证订单状态变为 Released

2. **非预言机权限验证**

3. **余额不足验证**

---

## 四、实现细节

### 创建 escrow token account 的方法
使用 `spl-token` 的 `createAssociatedTokenAccount` 或 `getOrCreateAssociatedTokenAccount`，注意：
- seeds = `["escrow", order_id.to_le_bytes()]`
- authority = order_account PDA
- mint = usdcMint

### 比例计算验证
测试用例：
- 总金额 1,000,000（6 decimals）
- B:30%, C:50%, D:20%
- 预期：
  - B: 300,000
  - C: 500,000
  - D: 200,000

---

## 五、文件修改
**仅修改** `/Users/chen/Desktop/solana_Code/four_party_contract/tests/four_party_contract.ts`
