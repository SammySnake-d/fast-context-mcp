---
stepsCompleted: ["validate-prerequisites", "design-epics", "create-stories"]
inputDocuments:
  - "_bmad-output/planning-artifacts/prd.md"
  - "deepgrep/ROADMAP-v1.1.md"
  - "_bmad-output/planning-artifacts/research-deepgrep-v1.2.md"
lastUpdated: 2026-06-07
---

# deepgrep v1.1 — Phân rã Epic

## Bảng kê Yêu cầu

**v1.1/v1.2 (đã xong):**
- FR1: Tự động nâng cấp quick → deep
- FR2: Kiểm chứng & hoàn thiện cache
- FR3: Trải nghiệm lỗi tốt hơn
- FR4: Công cụ kiểm tra tình trạng `deepgrep_status`
- FR5: Tinh chỉnh truy vấn (chế độ quick)
- FR6: Build binary đơn
- FR7: `deepgrep_get` tiết kiệm token
- FR8: Làm nóng cache (đóng dạng wont-do theo dữ liệu)

**v1.3 (backlog — Context Engine):**
- FR9: Hợp đồng output ổn định có cấu trúc (`output_format=json`, một `contract.mjs` duy nhất)
- FR10: Công cụ Context Pack `deepgrep_pack` (budget bắt buộc, nhãn vai trò)
- FR11: Xếp hạng & khử trùng lặp kết quả (module thuần `rank.mjs`)

**v2.0 (có cổng kiểm soát):**
- FR12: Tầng đánh chỉ mục tùy chọn (`deepgrep index`, cùng hợp đồng với zero-index)

**NFR:** NFR1-5 (độ trễ/phụ thuộc/tương thích), NFR6 (pack budget), NFR7 (heuristic vai trò không-AST).

## Bản đồ Bao phủ FR

| FR | Story | Trạng thái |
|----|-------|--------|
| FR2, NFR1 | 1.1 | ✅ xong |
| FR1, NFR2 | 1.2 (multi-hop/empty) | ✅ xong |
| FR5 | 1.2 (refineHint non-English) | ✅ xong — đặt chung với FR1 trong shouldEscalate |
| FR3 | 1.3 | ✅ xong |
| FR4 | 2.1 | ✅ xong |
| FR6 | 2.2 | ✅ xong |
| FR7 | 3.1 | ✅ xong |
| FR8 | 3.2 | 🚫 wont-do (do dữ liệu quyết định, xem file story) |
| FR9, ADR-8 | 4.1 | 🔲 backlog |
| FR11 | 4.3 | 🔲 backlog |
| FR10, NFR6, NFR7, ADR-9 | 4.2 | 🔲 backlog |
| FR12, ADR-10 | 5.1 | 🔒 có cổng kiểm soát |
| FR12 (multi-repo) | 5.2 | 🔒 có cổng kiểm soát |

## Danh sách Epic

- **Epic 1: Trí tuệ Lõi & Độ tin cậy (P0)** — cache, tự động nâng cấp, trải nghiệm lỗi. ✅ **Xong**
- **Epic 2: Trải nghiệm Lập trình viên (P1)** — công cụ kiểm tra tình trạng, build binary đơn. ✅ **Xong**
- **Epic 3: Truy xuất Tiết kiệm Token (v1.2)** — truy xuất hai giai đoạn deepgrep_get, warm cache. 🔲 **Backlog**

**Thứ tự v1.1:** Story 1.1 → 1.2 → 1.3 → 2.1 → 2.2 (tất cả đã xong)  
**Thứ tự v1.2:** Story 3.1 → 3.2 (tùy chọn)

---

## Epic 1: Trí tuệ Lõi & Độ tin cậy

### Story 1.1: Kiểm chứng & hoàn thiện cache kết quả

Với tư cách người dùng hằng ngày,
tôi muốn các truy vấn giống hệt nhau trên một codebase không đổi trả về tức thì từ cache,
để tôi tiết kiệm thời gian và token API.

**Tiêu chí Chấp nhận:**
- **Cho** một truy vấn đã chạy thành công, **Khi** chạy lại y hệt (cùng project_path + model, codebase chưa đổi), **Thì** trả từ cache, KHÔNG gọi API, < 100ms
- **Cho** file trong project thay đổi (mtime), **Khi** chạy lại truy vấn, **Thì** cache miss → gọi API
- **Cho** output, **Thì** metadata chứa `cache_hit: true|false`
- **Cho** `DEEPGREP_CACHE_DISABLED=1`, **Thì** cache bị bỏ qua hoàn toàn
- **Cho** `DEEPGREP_CACHE_TTL_MS=N`, **Thì** TTL áp dụng đúng

### Story 1.2: Tự động nâng cấp quick → deep (bao gồm FR1 + FR5)

Với tư cách người dùng không muốn phải chọn công cụ,
tôi muốn deepgrep tự động dùng chế độ deep cho truy vấn phức tạp và đưa ra gợi ý tinh chỉnh cho truy vấn mơ hồ,
để tôi luôn nhận kết quả tốt mà không phải lựa chọn.

**Tiêu chí Chấp nhận — FR1 (nâng cấp):**
- **Cho** truy vấn ≥3 mệnh đề hoặc chứa từ khóa multi-hop (trace/flow/across/from...to), **Khi** gọi deepgrep_search, **Thì** tự động nâng cấp sang chế độ deep
- **Cho** chế độ quick trả 0 kết quả, **Khi** auto_escalate=true, **Thì** thử lại bằng chế độ deep (1 lần)
- **Cho** truy vấn đơn giản 1 vế, **Thì** chạy quick, KHÔNG nâng cấp (không tăng độ trễ)
- **Cho** `auto_escalate=false`, **Thì** không bao giờ nâng cấp
- **Cho** output sau khi nâng cấp, **Thì** ghi rõ `[escalated to deep mode]`

**Tiêu chí Chấp nhận — FR5 (tinh chỉnh truy vấn, đặt chung với shouldEscalate):**
- **Cho** truy vấn non-English (phát hiện non-ASCII) hoặc mơ hồ, **Thì** `shouldEscalate` trả `refineHint` gợi ý diễn đạt lại bằng thuật ngữ code tiếng Anh
- **Cho** truy vấn non-English có thể nâng cấp, **Thì** vừa nâng cấp sang deep vừa thêm refineHint vào output (không loại trừ nhau)

**Vì sao đặt chung:** `shouldEscalate(query)` đã đánh giá toàn bộ đặc tính truy vấn (mệnh đề + từ khóa + non-ASCII) trong một lượt — tách FR5 thành story riêng sẽ trùng lặp logic. Các AC phía trên phân biệt rõ phần đóng góp của FR1 so với FR5.

### Story 1.3: Trải nghiệm lỗi tốt hơn

Với tư cách người dùng gặp giới hạn tần suất (rate limit) hoặc lỗi xác thực,
tôi muốn nhận thông báo lỗi rõ ràng, khả thi,
để tôi biết cách khắc phục vấn đề.

**Tiêu chí Chấp nhận:**
- **Cho** HTTP 429, **Thì** thông báo: "Model {X} rate limited — retrying / try DEEPGREP_MODEL=deep-search"
- **Cho** HTTP 403, **Thì** thông báo gợi ý dùng tổ hợp deep-search hoặc model khác
- **Cho** không có key, **Thì** trả URL đăng ký (giữ hành vi v1.0)
- **Cho** model deep fail sau khi thử lại, **Thì** gợi ý 1 model fallback cụ thể

---

## Epic 2: Trải nghiệm Lập trình viên

### Story 2.1: Công cụ kiểm tra tình trạng `deepgrep_status`

Với tư cách người dùng mới đang thiết lập deepgrep,
tôi muốn một lệnh kiểm tra tình trạng để xác minh cấu hình,
để tôi gỡ lỗi quá trình thiết lập mà không phải đoán mò.

**Tiêu chí Chấp nhận:**
- **Cho** công cụ `deepgrep_status` được gọi, **Thì** trả về: key hợp lệ? (kiểm tra ping), các model khả dụng (liệt kê + test 1-2), Devin Desktop đã cài chưa?, cấu hình hiện tại (URL/model/fast_backend)
- **Cho** key sai/thiếu, **Thì** báo rõ + URL đăng ký
- **Cho** Devin chưa cài, **Thì** ghi chú chế độ fast cần backend openai

### Story 2.2: Build binary đơn

Với tư cách người dùng không có Node,
tôi muốn một binary độc lập,
để tôi chạy được deepgrep mà không cần cài Node.

**Tiêu chí Chấp nhận:**
- **Cho** `bun build --compile`, **Thì** tạo binary chạy được không cần Node runtime
- **Cho** CI release, **Thì** build binary cho macOS/Linux/Windows kèm release artifacts
- **Cho** binary, **Khi** chạy `deepgrep_search`, `deepgrep_deep`, `deepgrep_status`, `deepgrep_get` qua MCP stdio, **Thì** mỗi công cụ trả output giống hệt bản npx (cùng schema, cùng xử lý lỗi, cùng biến môi trường)
- **Cho** binary, **Khi** các native deps (`@vscode/ripgrep`, `sql.js`) không bundle được, **Thì** hoãn lại theo ADR-5 và ghi tài liệu đường fallback (npx vẫn là kênh phân phối chính)


---

## Epic 3: Truy xuất Tiết kiệm Token (v1.2)

> Insight từ phân tích cạnh tranh (Augment Context Engine): Augment nổi bật nhờ **assembled context** — agent không phải tự đọc thêm file sau khi search. deepgrep hiện chỉ trả file + ranges, buộc agent phải `read_file` lại → tốn token. Epic này lấp khoảng trống đó với cách tiếp cận tiết kiệm token hơn Augment (agent chủ động chọn file nào cần đọc).

### Story 3.1: Công cụ `deepgrep_get` — Truy xuất code hai giai đoạn

Với tư cách lập trình viên (hoặc AI agent) dùng deepgrep,
tôi muốn lấy đúng đoạn code theo file + line ranges mà không phải đọc cả file,
để tôi tiết kiệm token và chỉ nhận đúng code mình thực sự cần.

**Tiêu chí Chấp nhận:**
- **Cho** một list `{file, ranges}` (output từ deepgrep_search), **Khi** gọi `deepgrep_get`, **Thì** trả code đúng range, có line numbers, không đọc ngoài range
- **Cho** `FC_SNIPPET_MAX_LINES` được set, **Thì** tổng số dòng trả về không vượt budget đó
- **Cho** file binary, **Thì** trả `[binary file — snippet omitted]` không crash
- **Cho** range vượt biên (out-of-bounds), **Thì** bỏ qua một cách nhẹ nhàng, trả các range hợp lệ còn lại
- **Cho** mảng `files` rỗng (hoặc `ranges` rỗng), **Thì** trả thông báo rõ ràng ("No files/ranges provided") KHÔNG crash
- **Cho** không cần API key, **Thì** công cụ hoạt động thuần local (không gọi API)
- **Cho** output, **Thì** định dạng rõ ràng: `file_path`, `line_start`, `line_end`, code block có line numbers

**Ví dụ output mẫu (tham chiếu cho test assert):**
```
## src/auth.mjs (L10-14)
10 | export function login(user, pass) {
11 |   const hash = hashPassword(pass);
12 |   const record = db.findUser(user);
13 |   if (!record) return null;
14 |   return record.hash === hash;
```

**Ghi chú kỹ thuật:**
- Tái dụng `src/snippets.mjs` → `readSnippets(files)` (đã implement sẵn)
- Thêm công cụ vào `src/server.mjs` tương tự deepgrep_status (không cần API key)
- **Input schema (ADR-6, Option A):** `files: z.array(z.object({ file: z.string(), ranges: z.array(z.tuple([z.number(), z.number()])) }))` — có cấu trúc, tự mô tả. Trường `file` = absolute path (khớp `full_path` từ deepgrep_search).
- Stateless: không liên kết session search→get. Agent tự truyền ranges từ output search.
- Mô tả công cụ nêu rõ quy trình 2 bước để LLM consumer biết khi nào gọi.
- Xem `architecture.md` ADR-6.

---

### Story 3.2: Làm nóng cache (tùy chọn, HOÃN)

Với tư cách người dùng làm việc lặp lại trên cùng một repo,
tôi muốn làm nóng (pre-warm) cache search cho các truy vấn phổ biến,
để truy vấn thật đầu tiên của tôi trả về tức thì.

**Tiêu chí Chấp nhận:**
- **Cho** công cụ MCP `deepgrep_warm` được gọi với project_path, **Thì** tính trước repo map và cache metadata
- **Cho** sau khi warm, truy vấn search đầu tiên không phải rebuild repo map từ đầu

**Ghi chú (ADR-7):**
- Cung cấp dưới dạng **công cụ MCP `deepgrep_warm`**, KHÔNG phải CLI subcommand (deepgrep là stdio MCP server, không phải CLI app).
- **HOÃN** trừ khi đo được việc tính repo-map là nút thắt thật sự (hiện ~100ms cho repo cỡ trung). Ship Story 3.1 trước, đánh giá lại sau.
- Xem `architecture.md` ADR-7.

---

## Epic 4: Context Engine Di động (v1.3) — 🔲 Backlog

> Chuyển dịch tầm nhìn (2026-06-08): deepgrep tiến hóa từ "công cụ semantic search" → "context engine không-chỉ-mục (zero-index)". Cùng công việc với Augment Context Engine, kiến trúc khác: lắp ráp theo nhu cầu, không có chỉ mục thường trú. Xem prd.md §9.

**Chủ đề:** Lắp ráp ngữ cảnh code theo từng tác vụ dưới một budget token rõ ràng — mà không cần đánh chỉ mục.

**Ràng buộc kiến trúc:** ADR-8 (một module contract duy nhất), ADR-9 (pack = orchestrator mỏng, 4 ràng buộc bắt buộc), ADR-10 (tương thích tiến cho tầng đánh chỉ mục). Xem architecture.md.

**Thứ tự thực thi (do phụ thuộc dẫn dắt):** 4.1 → 4.3 → 4.2. Contract trước (4.1), rồi ranking/roles tạo ra các trường có cấu trúc (4.3), rồi pack lắp ráp đầu vào đã xếp hạng+gán nhãn dưới budget (4.2). Xây pack trước ranking sẽ buộc phải ranking inline, mâu thuẫn với 4.3.

### Story 4.1: Hợp đồng output ổn định có cấu trúc  [làm ĐẦU TIÊN]

Với tư cách người xây dựng agent,
tôi muốn output JSON/metadata ổn định từ các công cụ deepgrep,
để tôi có thể kết hợp deepgrep với các công cụ và agent khác một cách đáng tin cậy.

**Tiêu chí Chấp nhận:**
- **Cho** bất kỳ lời gọi search/deep/get, **Khi** `output_format=json`, **Thì** trả về schema ADR-8 gồm `schema_version`, `files[]`, `grep_keywords[]`, `meta{backend,mode,cache_hit,retrieval,index_used,...}`
- **Cho** các trường hướng tới tương lai, **Thì** `retrieval="lexical"` và `index_used=false` luôn luôn (dành riêng cho Epic 5 — không phá vỡ tương thích)
- **Cho** chế độ text hiện có (mặc định), **Thì** không thay đổi (tương thích ngược)
- **Cho** toàn bộ serialization, **Thì** nằm trong MỘT module `src/contract.mjs` — không có nhánh JSON riêng cho từng công cụ
- **Cho** output JSON, **Thì** được bao phủ bởi các bài test cho search + get

### Story 4.3: Xếp hạng + khử trùng lặp kết quả  [làm THỨ HAI]

Với tư cách lập trình viên,
tôi muốn kết quả được sắp theo độ hữu ích với bản trùng được gộp lại,
để vài file đầu tiên thường là đủ.

**Tiêu chí Chấp nhận:**
- **Cho** nhiều kết quả, **Thì** các đường dẫn file trùng được gộp; các range chồng lấn trong cùng file được gộp
- **Cho** truy vấn không hỏi về test, **Thì** ưu tiên source hơn test/docs (heuristic theo path: `/test/`, `.test.`, `__tests__/`)
- **Cho** kết quả chế độ deep (LLM đã sắp xếp rồi), **Thì** rerank chỉ áp dụng cho kết quả nhiều file hoặc khi `rerank=true` rõ ràng — mặc định tin tưởng thứ tự của LLM
- **Cho** logic ranking, **Thì** nằm trong module thuần `src/rank.mjs` (test được độc lập, không gắn chặt với tool-handler)

### Story 4.2: Context Pack (`deepgrep_pack`)  [làm CUỐI CÙNG]

Với tư cách AI agent,
tôi muốn một context pack đã lắp ráp gọn từ kết quả search,
để tôi có thể trả lời hoặc chỉnh sửa mà không cần đọc cả file.

**Tiêu chí Chấp nhận (ràng buộc bởi ADR-9):**
- **Cho** một truy vấn (hoặc files/ranges từ search trước), **Khi** gọi `deepgrep_pack`, **Thì** trả về các snippet hàng đầu nhóm theo vai trò + đã sắp xếp (qua `src/rank.mjs`), trong giới hạn budget
- **Cho** budget `max_chars` (bắt buộc) và `max_lines` tùy chọn (gợi ý), **Thì** output không bao giờ vượt `max_chars`; các snippet bị loại được báo cáo rõ ràng
- **Cho** files/ranges được cung cấp trực tiếp, **Thì** thuần local — không cần API key (kế thừa thế stateless của ADR-6)
- **Cho** mỗi snippet, **Thì** nhãn vai trò qua heuristic `src/roles.mjs` (implementation/caller/config/test/docs/type) — chỉ dựa trên path + tên file + mật độ match, KHÔNG dùng AST / language server
- **Cho** phần implementation, **Thì** tái dụng `readSnippets` + `formatSnippetToolOutput` (Story 3.1), không bao giờ trùng lặp snippet I/O
- **Cho** mỗi case heuristic vai trò, **Thì** đi kèm một test fixture (chặn việc heuristic phình to)

---

## Epic 5: Tầng Đánh Chỉ mục Tùy chọn (v2.0) — 🔒 Có cổng kiểm soát / Khát vọng

> NORTH STAR, KHÔNG PHẢI BACKLOG. Một context engine thường trú kiểu Augment, nhưng local-first và opt-in. KHÔNG bắt đầu cho đến khi cổng kiểm soát được mở. Xem prd.md §9 North Star.

**Cổng kiểm soát (≥2 điều phải đo được là đúng trước khi mở):**
1. Đo được zero-index quá chậm / recall kém trên repo lớn
2. Nhu cầu lặp lại về multi-repo hoặc bộ nhớ project thường trú
3. Các luồng agent cần ngữ cảnh xuyên-phiên (cross-session)
4. Kích thước repo vượt giới hạn thực tế của embedding theo nhu cầu

**Nếu cổng không bao giờ mở, epic này không bao giờ được xây — và đó là kết cục chấp nhận được.** Lợi thế (moat) zero-index là ưu tiên.

### Story 5.1 (có cổng kiểm soát): Chỉ mục tăng dần local-first

Với tư cách người dùng có repo lớn nơi zero-index quá chậm,
tôi muốn một chỉ mục local opt-in,
để việc truy xuất vẫn nhanh mà không gửi code lên dịch vụ cloud.

**Tiêu chí Chấp nhận (bản nháp, tinh chỉnh lúc mở cổng):**
- **Cho** `deepgrep index`, **Thì** xây chỉ mục local `.deepgrep/` tăng dần (dựa trên mtime)
- **Cho** chế độ indexed, **Thì** cùng output contract với zero-index (backend ẩn)
- **Cho** không có chỉ mục, **Thì** chế độ zero-index vẫn hoạt động như mặc định (không phá vỡ tương thích)
- **Cho** BYOM, **Thì** embeddings dùng model do caller cung cấp, không khóa nhà cung cấp
- **Ràng buộc:** vẫn KHÔNG có symbol graph / refactor / editing (đó là địa hạt của Serena)

### Story 5.2 (có cổng kiểm soát): Ngữ cảnh đa repo (có thể)

Với tư cách lập trình viên làm việc xuyên các repo liên quan,
tôi muốn việc lắp ráp ngữ cảnh trải rộng nhiều repo local,
để các tác vụ xuyên-repo có được ngữ cảnh phù hợp.

**Trạng thái:** Placeholder. Chỉ định nghĩa nếu nhu cầu multi-repo là thật lúc mở cổng.

## Tóm tắt Roadmap (cập nhật 2026-06-08)

| Phiên bản | Chủ đề | Trạng thái |
|---------|-------|--------|
| v1.1 | Trí tuệ Lõi + Trải nghiệm Lập trình viên (Epic 1-2) | ✅ Xong |
| v1.2 | Truy xuất Tiết kiệm Token — `deepgrep_get` (Epic 3) | ✅ 3.1 đã xong, 3.2 wont-do |
| v1.3 | Context Engine Di động (Epic 4) | 🔲 Backlog |
| v1.5 | Phân phối: CLI parity, binary đơn, công thức tích hợp | 🔲 Tương lai |
| v2.0 | Tầng Đánh Chỉ mục Tùy chọn (Epic 5) | 🔒 Có cổng / khát vọng |
