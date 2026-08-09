# Phase 1: deepgrep — Validation MVP

**Product:** `deepgrep` — AI code search that THINKS, not just matches.
**Tagline:** "Zero-index semantic code search for AI agents"
**npm:** `deepgrep` (confirmed available)
**Timeline:** 3 ngày build + 11 ngày validate
**Success = 1 người lạ trả $15**

---

## Positioning (học từ ai-grep + differentiation)

### The Problem (giữ framing của ai-grep — nó đúng)

> AI agents (Claude Code, Kiro, Codex) waste tokens grepping blindly.
> grep "auth" → 200 matches → agent reads 10 files → still lost.
> 22 tool calls. $0.56 in tokens. 58 seconds.

### Our Solution (khác biệt rõ ràng vs ai-grep)

> **deepgrep** thinks like a developer — not just matches keywords.
> It asks an AI to reason about your codebase, grep strategically, and trace logic across files.
>
> 1 query → precise file + line ranges → done.
> Zero index. Zero setup. Zero daemon. Just `npx deepgrep`.

### Competitive table (for landing page + README)

| | grep/ripgrep | ai-grep | **deepgrep** |
|---|---|---|---|
| Setup | None | Install Rust + 800MB models + daemon | **`npx deepgrep`** |
| Understands meaning | ❌ | ✅ (embedding match) | ✅ (**AI reasoning**) |
| Multi-hop tracing | ❌ | ❌ | ✅ ("trace data flow from X → Y → Z") |
| Needs index | No | Yes (per project) | **No** |
| Works offline | ✅ | ✅ | Fast mode: ✅, Deep mode: needs API |
| Accuracy (complex queries) | Low | Medium | **High (100% benchmark)** |
| Cost | Free | Free | Fast: free / Deep: $15/mo |
| MCP support | ❌ | ✅ | ✅ |

---

## Nguyên tắc chỉ đạo

1. **KHÔNG build tính năng mới.** Ship cái có. Validate demand.
2. **Paywall từ ngày 1.** Deep mode = paid. Cần biết willingness-to-pay.
3. **Zero-friction install** — `npx deepgrep` → chạy ngay. Không daemon, không model download.
4. **Đo mọi thứ.** Signup → activation → payment.

---

## Ngày 1: Package + Gating

### Task 1.1: Create new package

```json
{
  "name": "deepgrep",
  "version": "1.0.0",
  "description": "AI code search that thinks — zero-index semantic search for any MCP client",
  "type": "module",
  "main": "src/server.mjs",
  "bin": { "deepgrep": "src/server.mjs" },
  "files": ["src/", "README.md", "LICENSE"],
  "keywords": ["mcp", "code-search", "semantic-search", "ai", "grep", "deepgrep", "claude", "cursor", "kiro"],
  "license": "MIT"
}
```

- Repo: `deptrai/deepgrep` (private)
- Copy source từ fast-context-mcp (bỏ _bmad-output, bug reports, diagnostic files)
- Loại bỏ `@sammysnake` references
- Giữ bin name `deepgrep`

### Task 1.2: Deep mode gating

Sửa `src/server.mjs`:

```javascript
const DEEP_BASE_URL = process.env.DEEPGREP_API_URL || "https://api.deepgrep.chainlens.net/v1";
const DEEP_API_KEY = process.env.DEEPGREP_API_KEY || "";
const DEEP_MODEL = process.env.DEEPGREP_MODEL || "deep-search";
```

Khi không có key:
```
⚡ Deep search requires an API key.

Get yours free (includes 10 deep queries/day):
  → https://deepgrep.chainlens.net

Then add to your MCP config:
  "env": { "DEEPGREP_API_KEY": "your-key" }

💡 Tip: fast mode (deepgrep_search) works free without a key.
```

### Task 1.3: Rename tools cho brand

| Cũ | Mới | Lý do |
|---|---|---|
| `fast_context_search` | `deepgrep_search` | Brand-first, gợi nhớ |
| `deep_context_search` | `deepgrep_deep` | Rõ ràng: deep = paid tier |
| `extract_windsurf_key` | Bỏ hoặc hide | User không cần biết internals |

### Task 1.4: Telemetry (anonymous, opt-out)

Khi tool khởi động lần đầu:
- Gửi 1 event: `{event: "install", version, os, node_version}` → endpoint đơn giản
- `DEEPGREP_NO_TELEMETRY=1` để tắt
- Ghi rõ trong README

Khi chạy deep query:
- 9router log đã track: key_id, timestamp, model, success/fail → đủ

---

## Ngày 2: Signup + Payment + Domain

### Task 2.1: Domain + Landing

**Domain:** `deepgrep.chainlens.net` (hoặc `.io` nếu `.dev` bị chiếm — check)

**Landing page (1 trang, Vercel/static):**

```
HERO:
"AI code search that thinks — not just matches"
Subline: "Zero-index. Zero-setup. Just npx deepgrep."

DEMO GIF: Kiro/Claude asking "trace the auth flow" → precise results

3-STEP SETUP:
1. npx deepgrep (or add to MCP config)
2. Get free API key (10 deep queries/day)
3. Ask your codebase anything

COMPARISON TABLE (grep vs ai-grep vs deepgrep)

PRICING:
Free: fast mode unlimited + 10 deep/day
Pro $15/mo: unlimited deep, priority models

"Get Free API Key" → signup form

FOOTER: "Powered by frontier AI models. Your code never leaves your machine."
```

**Analytics:** Plausible hoặc PostHog (privacy-friendly)

### Task 2.2: Signup flow (MVP)

**Tuần 1 — manual (đủ cho <50 users):**
- Tally form: email + IDE dùng
- Bạn generate key thủ công trong 9router dashboard
- Email key cho user (template có sẵn)

**Tuần 2+ — tự động (khi >50 signups):**
- `POST /api/signup {email}` → auto-generate key → email

### Task 2.3: Stripe

- Stripe Payment Link: `$15/mo` subscription
- Landing page link "Upgrade to Pro"
- Khi paid → manual upgrade key tier (tuần 1). Auto webhook later.

### Task 2.4: 9router tier enforcement

- Free key prefix `dg-free-*`: 10 deep requests/ngày
- Pro key prefix `dg-pro-*`: unlimited (5000/day safety)
- Hết quota → 429 + message: "Daily free limit reached. Upgrade: https://deepgrep.chainlens.net/pro"

---

## Ngày 3: Publish + Launch

### Task 3.1: Publish npm

```bash
npm publish  # → deepgrep@1.0.0 on registry
npx deepgrep  # verify it starts
```

### Task 3.2: README marketing (trong package — users đọc trên npmjs.com)

```markdown
# deepgrep

AI code search that **thinks** — not just matches keywords.

> "trace the authentication flow" → precise files + line ranges in 3 seconds.
> Zero index. Zero setup. Works with Kiro, Claude Code, Cursor, Codex.

## Quick Start (30s)

### Any MCP client (Kiro, Claude Desktop, Cursor)
{
  "deepgrep": {
    "command": "npx",
    "args": ["-y", "deepgrep"],
    "env": { "DEEPGREP_API_KEY": "your-key" }
  }
}

Get your free key: https://deepgrep.chainlens.net

## How It Works
Unlike embedding-based tools (need indexing, daemon, 800MB models),
deepgrep uses AI reasoning: it reads your project structure, greps
strategically, traces logic across files, and returns precise results.

Your code stays on YOUR machine. Only the search query goes to our API.

## Two Modes
| Mode | Speed | Use case | Cost |
|------|-------|----------|------|
| `deepgrep_search` | ~3s | Quick lookups | Free (no key needed) |
| `deepgrep_deep` | ~20s | Complex tracing, architecture questions | API key (free tier: 10/day) |

## Pricing
- Free: fast unlimited + 10 deep/day
- Pro ($15/mo): unlimited deep
```

### Task 3.3: Launch posts (chuẩn bị sẵn, đăng rải trong tuần)

**Reddit (r/ChatGPTCoding, r/cursor, r/ClaudeAI):**
> Title: "I built a free semantic code search for AI agents — works with Claude Code, Cursor, Kiro"
> Body: Problem (agents waste tokens grepping) → solution (AI that thinks) → comparison table → how to try (npx deepgrep)
> Tone: sharing value, not selling

**X/Twitter:**
> "grep finds strings. deepgrep finds meaning.
> AI code search that traces logic across your entire codebase — zero index, zero setup.
> Free: npx deepgrep
> [demo gif]"

**HN (Show HN):**
> Title: "Show HN: deepgrep – AI semantic code search for any MCP client (no index needed)"
> Focus on: technical approach (agentic loop vs embeddings), zero-setup DX, benchmarks

---

## Tuần 2: LEARN

### Metrics (theo dõi hàng ngày)

| Metric | Source | Trả lời |
|--------|--------|---------|
| Landing visits | Plausible | Posts có viral? |
| Signup count | Form submissions | Có ai muốn thử? |
| npm installs/week | npmjs.com stats | Có ai dùng? |
| First deep query | 9router logs | Activation OK? |
| Free → Pro conversion | Stripe | **CÓ AI TRẢ TIỀN?** |
| Daily active (queries) | 9router logs | Retention? |

### Talk to users

Mỗi signup → email cá nhân (first 20):
- "Hey, thanks for trying deepgrep. Quick question: what IDE are you using, and what kind of queries do you usually search for?"
- Mục tiêu: hiểu use case thật, pain point, willingness-to-pay

### Decision Gate (cuối tuần 2)

| Signal | Meaning | Action |
|--------|---------|--------|
| ≥3 paid users | Product-market fit signal | Scale marketing, automate |
| Signups nhưng 0 paid | Value/price mismatch | Adjust tier/pricing |
| Installs nhưng ít signups | Onboarding friction | Simplify setup/messaging |
| ~0 everything | No market | Pivot or kill |

---

## KHÔNG làm trong Phase 1

- ❌ Embedding index, dependency graph, context engine
- ❌ Full auth system (manual OK)
- ❌ Dashboard (9router logs + Stripe đủ)
- ❌ Team features, multi-repo
- ❌ Tự động hoá (manual đến khi đau)
- ❌ Over-polish code (working > pretty)

---

## Pháp lý trước khi nhận tiền

- [ ] Kiểm domain: `deepgrep.chainlens.net` / `.io` available?
- [ ] Confirm quyền resell models qua 9router (ToS upstream providers)
- [ ] Fast mode (SWE-1.6): nếu rủi ro cao → đổi sang Haiku qua router ($0.005/query acceptable)
- [ ] Privacy Policy đơn giản (ghi rõ: code local, chỉ query text gửi API)
- [ ] Terms of Service basic

---

## Tổng kết chiến lược

```
deepgrep (npm, free, open MCP tool)
    ↓ user thấy giá trị fast mode
    ↓ muốn deep mode (complex queries)
    ↓ signup lấy key
    ↓ free 10/day đủ thử, thấy hay
    ↓ upgrade Pro $15/mo
    ↓ === REVENUE ===
    ↓
9router (proxy infra, bạn own)
    ↓ route → Sonnet 4.6 / GPT-5.5 combo
    ↓ cost ~$0.02/query, charge $15/mo unlimited
    ↓ margin dương khi user dùng <750 deep queries/mo (rất realistic)
```

Ship ngày 1. Validate ngày 14. Quyết định ngày 15.
