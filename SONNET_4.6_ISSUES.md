# Sonnet 4.6 via 9router — Investigation Report

Báo cáo các vấn đề khiến `kr/claude-sonnet-4.6` trả về 0 files / ERR khi dùng làm backend cho fast-context, trong khi `cx/gpt-5.5` hoạt động ổn định.

**Endpoint**: `https://router.chainlens.net/v1`
**Date**: 2026-06-06
**Test project**: chainlens monorepo (~3500 files)

---

## Tóm tắt

| Model | Q1 (auth) | Q2 (BullMQ) | Forced tool_choice tôn trọng? |
|-------|-----------|-------------|-------------------------------|
| cx/gpt-5.5 | ✅ 5 files | ✅ 5 files | (xem Issue #2) |
| kr/claude-sonnet-4.6 | ❌ ERR "max turns" | ❌ ERR "max turns" | ❌ KHÔNG |
| kr/claude-haiku-4.5 | ✅ 4 files | ✅ 3 files | một phần |

Cả Sonnet và GPT-5.5 đều gọi tool đúng ở turn đầu, nhưng Sonnet **không bao giờ chuyển sang gọi `answer` tool**, dẫn tới "Max turns reached without answer".

---

## Issue #1 — `tool_choice` ép buộc (named function) KHÔNG được proxy tôn trọng

**Đây là nguyên nhân chính.**

Code force model gọi tool `answer` ở turn cuối bằng:
```json
"tool_choice": { "type": "function", "function": { "name": "answer" } }
```

### Bằng chứng (multi-turn test)

Sau khi đẩy kết quả `restricted_exec` vào hội thoại và ép `tool_choice = answer`, Sonnet 4.6 **vẫn gọi `restricted_exec`** thay vì `answer`:

```
TURN 2 (force answer, tool_choice={function:answer})
  finish: tool_calls
  tool_calls: [ 'restricted_exec' ]      ← SAI, đáng lẽ phải là 'answer'
  answer arg: {"command1": {"path":"/codebase/src/auth.ts","type":"readfile"}}
```

### Bằng chứng (single-turn test, ép answer)

```
cx/gpt-5.5            | forced=answer → called: none | finish: stop | completion_tokens: 47
kr/claude-sonnet-4.6 | forced=answer → called: none | finish: stop | completion_tokens: 45
kr/claude-haiku-4.5  | forced=answer → called: none | finish: stop | completion_tokens: 21
```

→ Khi ép `tool_choice` tới một named function, proxy trả về **text response (finish=stop)** thay vì bắt buộc gọi function đó. Với cả 3 model.

### Giả thuyết nguyên nhân
- Anthropic API dùng format `tool_choice: { "type": "tool", "name": "answer" }`.
- OpenAI API dùng format `tool_choice: { "type": "function", "function": { "name": "answer" } }`.
- **Proxy có thể không dịch (translate) đúng OpenAI→Anthropic format cho named tool_choice**, nên Anthropic backend nhận `tool_choice` không hợp lệ → fallback về `auto` hoặc text.

### Cần investigate
1. Kiểm tra code translation layer của 9router cho field `tool_choice` khi route tới `kr/` (Anthropic) models.
2. So sánh request body 9router gửi lên Anthropic upstream khi nhận `tool_choice: {type:function,...}`.
3. Kiểm tra xem proxy có support `tool_choice: "required"` (OpenAI) → map sang `tool_choice: {type:"any"}` (Anthropic) không.

---

## Issue #2 — `completion_tokens: 0` khi trả về tool_calls

Khi model trả về tool call ở turn đầu, usage report sai:

```
TEST 1: Initial tool call
  finish_reason: tool_calls
  tool_calls: [restricted_exec với arguments hợp lệ]
  usage: {"prompt_tokens":2974, "completion_tokens":0, "total_tokens":2974}
```

`completion_tokens=0` dù model rõ ràng đã sinh ra tool call arguments.

### Giả thuyết
- Khi `stream:false` nhưng upstream Anthropic trả streaming rồi proxy gom lại, phần token đếm cho tool_use block có thể bị bỏ.
- Ảnh hưởng: billing/quota tracking sai (không phải lỗi chức năng nhưng cần lưu ý).

---

## Issue #3 — Sonnet hallucinate command `type` không hợp lệ

Turn đầu, Sonnet sinh ra `"type":"find"`:
```json
{"command1": {"type":"find","path":"/codebase","pattern":"*auth*"}}
```

`find` KHÔNG nằm trong enum hợp lệ (`rg`, `readfile`, `tree`, `ls`, `glob`). Executor trả error → model phải thử lại → tốn turn.

### Giả thuyết
- Schema `command1.properties.type` trong tool definition chưa khai báo `enum`, nên model tự bịa.
- **Fix phía client**: thêm `enum: ["rg","readfile","tree","ls","glob"]` vào schema `type`.
- Đây là vấn đề schema, không phải proxy, nhưng làm trầm trọng thêm Issue #1 (tốn turn → dễ chạm max turns).

---

## Issue #4 — Không có hành vi "answer" tự nhiên

Ngay cả khi KHÔNG ép `tool_choice`, Sonnet 4.6 có xu hướng tiếp tục gọi `restricted_exec` qua nhiều turn mà không tự quyết định gọi `answer`, trong khi GPT-5.5 biết dừng và trả lời. Có thể do:
- System prompt chưa đủ rõ ràng cho Sonnet về điều kiện dừng.
- Hoặc Sonnet "thận trọng" hơn, muốn thu thập thêm context.

---

## Đề xuất hướng fix (client-side, để test isolate proxy)

1. **Thêm `enum` cho command type** trong `_buildOpenAITools()` → loại bỏ Issue #3.
2. **Thử `tool_choice: "required"`** (thay vì named function) ở turn cuối → xem proxy có map sang Anthropic `tool_choice:{type:"any"}` không.
3. **Fallback parse**: nếu turn cuối model vẫn gọi `restricted_exec` thay vì `answer`, parse các file path từ readfile/rg args đã thực thi để dựng answer thủ công.
4. **Tăng max_turns cho Sonnet** (3-4) vì nó "thận trọng" hơn.

## Lệnh tái hiện

```bash
# Multi-turn forced-answer test (chứng minh Issue #1)
node --input-type=module -e "<diagnostic script trong git history>"

# So sánh các model
curl -s https://router.chainlens.net/v1/chat/completions \
  -H "Authorization: Bearer <KEY>" -H "Content-Type: application/json" \
  -d '{"model":"kr/claude-sonnet-4.6","messages":[...],"tools":[...],"tool_choice":{"type":"function","function":{"name":"answer"}}}'
```
