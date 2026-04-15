# Stub Risk Map

A detailed mapping of current stubbed code execution paths to real-world deployment risks. 
When `DRY_RUN=false` is set in production, these gaps represent immediate failure points or silent logic holes.

| Component | Stub Behavior | What Breaks When Real | Risk Level | Mitigation |
|-----------|--------------|----------------------|------------|------------|
| Executor (Kamino) | Returns empty TX + stub sim | No lending/vault deposit instruction will be executed. The system will believe it deposited funds, but the capital remains idle in the wallet. | 🔴 HIGH | Implement Kamino SDK integration inside `executor/kamino.ts` mapping to real instructions. |
| Executor (Marginfi) | Returns empty TX + stub sim | No borrow/lend instruction generated. The position opens logically in sqlite but physically doesn't exist. | 🔴 HIGH | Implement Marginfi SDK integration mapping to their client implementation. |
| Executor (close/rebalance) | Returns empty TX + stub sim | No withdrawal instruction generated across any protocol. Funds are trapped or rebalance actions simply do nothing while updating DB state. | 🔴 HIGH | Implement per-protocol close flows (`withdrawSol`, etc). |
| Executor (Jito) | Real `depositSol` instruction | **Works** — but requires manual Phantom sign because the agent doesn't hold the keypair securely. If unsigned, the graph awaits human-in-the-loop forever or fails simulation manually. | 🟡 MED | Add secure keypair signing functionality (Phase 2+). |
| Executor (Meteora) | Real DLMM deposit params, simulated TX | SDK-level deposit params are real; TX simulation will fail if wallet has no SOL, or may require more complex instruction arrays for creating ATA's on the fly. | 🟡 MED | Validate against mainnet simulation and add ATA construction logic. |
| Default dispatch handler | Logs signals, no LangGraph execution | Agent makes no decisions, acts as a sophisticated logger. | 🟢 LOW | Already wired to LangGraph via `langGraphHandler` in `agent.ts`. |
| Daily HEARTBEAT | Fires once at midnight | Fails to detect loop crashes or networking lockups mid-day. | 🟢 LOW | Fixed: Added 5-min pipeline heartbeat tracking and Telegram bounds. |
| Telegram HITL | Sends approval buttons to CIO | Docker networking creates race conditions with default bot polling causing message drops. | 🟢 LOW | Fixed: Polling explicitly configured to 2s intervals with 30s connection timeout. |
