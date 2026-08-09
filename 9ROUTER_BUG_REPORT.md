# Bug Report: Claude models trả response malformed trong multi-turn + large-context tool calling (9router proxy)

**Endpoint**: `https://router.chainlens.net/v1/chat/completions`
**Affected models**: `kr/claude-sonnet-4.6` (và các biến thể `-thinking`, `-agentic`); nghi ngờ ảnh hưởng tất cả `kr/claude-*`
**Hoạt động bình thường**: `cx/gpt-5.5` (OpenAI upstream) — ổn định 100% cùng payload
**Date**: 2026-06-06
**Severity**: High — model không dùng được cho agentic multi-turn workflows (code search, tool loops)

---

## TL;DR cho dev

Sau khi đã fix `convertOpenAIToolChoice` (single-turn forced tool_choice đã OK), **vẫn còn bug ở multi-turn + large context**:

> Khi conversation có nhiều round tool-calling VÀ payload lớn (~25KB system/user content + nhiều `role:"tool"` messages với output nặng), proxy **intermittently** trả về response **malformed**: thiếu `finish_reason`, `usage.completion_tokens` = `undefined`/`0`, và đôi khi cấu trúc `choices[0]` không đúng OpenAI spec.

GPT-5.5 với **chính xác cùng payload** không bao giờ gặp lỗi này → vấn đề nằm ở **đường translation OpenAI ↔ Anthropic của proxy cho Claude models**, không phải ở client.

---

## Reproduction

### Setup
- Conversation: 1 system + 1 user (user chứa repo tree ~25KB) + 3 cặp `(assistant tool_call, tool result)`.
- Mỗi tool result ~50 dòng (~5KB).
- Turn cuối ép `tool_choice: { "type": "function", "function": { "name": "answer" } }`.

### Quan sát (reproducible)

```
T1 (auto): called=restricted_exec finish=tool_calls ctok=70
T2 (auto): called=restricted_exec finish=tool_calls ctok=32
T3 (auto): called=(text)          finish=undefined   ctok=undefined   ← MALFORMED
FORCE answer: called=(text)       finish=undefined   ctok=undefined   ← MALFORMED
>>> BUG: HTTP 200 nhưng choices[0].finish_reason = undefined, usage.completion_tokens = undefined
tree size: 24.8KB
```

So sánh: cùng kịch bản với **payload nhỏ** (không có repo tree, tool output ngắn) → `FORCE answer: called=answer finish=tool_calls ctok=63` ✅ **đúng**.

→ Lỗi chỉ xuất hiện khi **context đủ lớn + nhiều turn**.

---

## Các triệu chứng cụ thể

### Symptom A — `finish_reason` và `usage` undefined (HTTP 200)
Response trả HTTP 200 nhưng `choices[0].finish_reason` = `undefined` và `usage.completion_tokens` = `undefined`. Client không phân biệt được đây là lỗi hay hoàn thành → coi như turn rỗng → lặp vô ích tới max turns → "Max turns reached without answer".

### Symptom B — `completion_tokens: 0` cho tool-call response
Ngay cả khi response hợp lệ và có `tool_calls`, `usage.completion_tokens` thường = `0`. Sai cho billing/quota. Nghi ngờ: khi gom (aggregate) streaming response từ Anthropic về non-stream, phần `tool_use` block không được tính token.

### Symptom C — message trả về CẢ `content` LẪN `tool_calls`
Claude thường trả `message.content` (text reasoning) đồng thời với `tool_calls` trong cùng một message. Hợp lệ theo OpenAI spec, nhưng:
- Một số client chỉ đọc `tool_calls` HOẶC `content`, gây bỏ sót.
- Cần đảm bảo proxy luôn map đầy đủ cả 2 field, và set `finish_reason: "tool_calls"` đúng khi có tool_calls.

### Symptom D — nondeterministic
Cùng một query chạy nhiều lần: lúc trả 1 file, lúc 5 files, lúc ERR. GPT-5.5 deterministic hơn hẳn. Gợi ý proxy có race/timing trong khâu aggregate streaming cho Claude.

---

## Giả thuyết nguyên nhân (cho dev khoanh vùng)

1. **Streaming aggregation cho Claude bị cắt khi payload lớn**
   - Khi `stream:false`, proxy có thể đang gọi Anthropic ở chế độ streaming rồi tự gom lại.
   - Với context lớn, response Anthropic chứa nhiều SSE event (`content_block_start/delta/stop`, `message_delta` với `stop_reason`).
   - Nghi ngờ proxy **đóng stream sớm** hoặc **không parse được event `message_delta.stop_reason`** → thiếu `finish_reason`, thiếu `usage`.

2. **Mapping `stop_reason` → `finish_reason` bị miss trong một số nhánh**
   - Anthropic `stop_reason: "tool_use"` → phải map thành OpenAI `finish_reason: "tool_calls"`.
   - Khi message có cả text + tool_use, nhánh mapping có thể bị bỏ qua → `finish_reason` undefined.

3. **`max_tokens` / context window**
   - Kiểm tra xem proxy có forward đúng `max_tokens` không, và liệu input lớn có làm Anthropic trả `stop_reason: "max_tokens"` mid-tool-call (tool_use bị cắt → JSON arguments không hợp lệ).

4. **Buffer/timeout nội bộ proxy**
   - Response lớn có thể chạm giới hạn buffer hoặc timeout của tầng aggregate, trả về partial JSON.

---

## Yêu cầu fix (acceptance criteria)

Một response từ `kr/claude-*` phải LUÔN thỏa mãn, kể cả với context lớn + multi-turn:

1. `choices[0].finish_reason` luôn có giá trị hợp lệ (`stop` | `tool_calls` | `length`). **Không bao giờ `undefined`.**
2. `usage.completion_tokens` phản ánh đúng số token sinh ra, kể cả khi response là tool_call (**không = 0/undefined** khi có tool_calls).
3. Khi Anthropic `stop_reason = "tool_use"` → map `finish_reason = "tool_calls"`.
4. `tool_choice: {type:"function", function:{name:"X"}}` được tôn trọng kể cả ở turn thứ N của conversation dài (map sang Anthropic `tool_choice: {type:"tool", name:"X"}`).
5. Hành vi deterministic tương đương GPT-5.5 với cùng payload.
6. Nếu Anthropic trả `stop_reason: "max_tokens"` cắt ngang tool_use → proxy phải báo `finish_reason: "length"` rõ ràng (không trả tool_calls với arguments JSON hỏng).

---

## Test cases dev nên thêm vào regression suite

| # | Kịch bản | Expected |
|---|----------|----------|
| 1 | Single-turn, force tool_choice=answer, payload nhỏ | `finish_reason=tool_calls`, gọi đúng `answer` |
| 2 | 3-turn tool loop, payload nhỏ, force answer cuối | `finish_reason=tool_calls`, gọi `answer` |
| 3 | **3-turn tool loop, user content ~25KB + 3 tool results ~5KB mỗi cái, force answer** | `finish_reason=tool_calls`, `completion_tokens>0`, **không undefined** |
| 4 | Cùng case #3 chạy 10 lần | 10/10 đều có `finish_reason` hợp lệ (deterministic) |
| 5 | So sánh #3 giữa `kr/claude-sonnet-4.6` và `cx/gpt-5.5` | Cùng shape response hợp lệ |

---

## Lệnh tái hiện (Node.js, chạy được ngay)

```js
// reproduce.mjs — node reproduce.mjs
const BASE='https://router.chainlens.net/v1';
const KEY='<API_KEY>';
const tools=[
  { type:'function', function:{ name:'restricted_exec', description:'Run commands',
    parameters:{type:'object',properties:{command1:{type:'object',
      properties:{type:{type:'string'},pattern:{type:'string'},path:{type:'string'}},required:['type']}},required:['command1']} } },
  { type:'function', function:{ name:'answer', description:'Final answer XML',
    parameters:{type:'object',properties:{answer:{type:'string'}},required:['answer']} } }
];
async function call(messages, toolChoice){
  const r=await fetch(BASE+'/chat/completions',{method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+KEY},
    body:JSON.stringify({model:'kr/claude-sonnet-4.6',messages,tools,tool_choice:toolChoice,max_tokens:2048,stream:false})});
  return { status:r.status, body: await r.json() };
}
// large-ish content to trigger the bug
const big = Array.from({length:50},(_,i)=>'/codebase/apps/api/src/file'+i+'.ts:'+i+': long matched code line to simulate real grep output content here').join('\n');
const fakeTree = Array.from({length:400},(_,i)=>'  /codebase/apps/api/src/dir'+i+'/mod'+i+'.ts').join('\n'); // ~20KB
const msgs=[
  {role:'system',content:'Code search agent. Use restricted_exec then call answer with XML.'},
  {role:'user',content:'Trace wallet risk scoring data flow.\nRepo:\n'+fakeTree}
];
for (let t=1;t<=3;t++){
  msgs.push({role:'assistant',content:null,tool_calls:[{id:'tc'+t,type:'function',
    function:{name:'restricted_exec',arguments:'{\"command1\":{\"type\":\"rg\",\"pattern\":\"wallet\",\"path\":\"/codebase\"}}'}}]});
  msgs.push({role:'tool',tool_call_id:'tc'+t,content:'<command1_result>\n'+big+'\n</command1_result>'});
}
const rf=await call(msgs,{type:'function',function:{name:'answer'}});
console.log('HTTP', rf.status, '| finish_reason:', rf.body.choices?.[0]?.finish_reason,
            '| completion_tokens:', rf.body.usage?.completion_tokens);
console.log(JSON.stringify(rf.body.choices?.[0], null, 2).slice(0,800));
// BUG: finish_reason undefined / completion_tokens undefined intermittently
```

---

## Context: tại sao quan trọng

App `fast-context-mcp` dùng các model này cho agentic code search (multi-turn tool loop). Hiện phải fallback về `cx/gpt-5.5` cho query phức tạp vì Claude models không ổn định ở multi-turn. Sau khi fix, `kr/claude-sonnet-4.6` (nhanh hơn GPT-5.5 ~2x: 20s vs 50s) sẽ thành default deep-search model.
