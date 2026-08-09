# Story 0: Deploy MCP lên npm

Status: ready-for-dev

## Story

As the maintainer,
I want to publish phiên bản mới lên npm,
so that users có thể `npx @sammysnake/fast-context-mcp` với features mới nhất (Devin Desktop support, deep_context_search, combo model).

## Thông tin hiện tại

| Field | Value |
|---|---|
| Package name | `@sammysnake/fast-context-mcp` |
| Current published version | `1.2.1` |
| New version | `1.3.0` (hoặc giữ 1.2.1 nếu chưa bump) |
| Scope | `@sammysnake` (scoped, public) |
| Registry | https://registry.npmjs.org |
| CI/CD | `.github/workflows/publish.yml` — auto publish on GitHub Release |
| Auth | GitHub OIDC (provenance) — KHÔNG cần npm token local |

## Có 2 cách deploy

---

### Cách 1: Qua GitHub Release (KHUYẾN NGHỊ — dùng CI/CD sẵn có)

Workflow đã set up sẵn: tạo Release trên GitHub → tự động publish lên npm.

**Bước thực hiện:**

```bash
# 1. Sửa version trong package.json và server.mjs trong cùng commit
# (không dùng `npm version` trước commit vì lệnh đó tự tạo commit + tag)

# 2. Commit + push
git add -A
git commit -m "chore: bump version to 1.3.0"
git push origin main

# 3. Tạo GitHub Release (tag được tạo trên đúng commit đã sync version)
# Option A: CLI (nhanh nhất)
gh release create v1.3.0 --title "v1.3.0" --notes "
## What's New
- Devin Desktop support (auto-detect key from Devin local DB)
- New tool: deep_context_search (GPT-5.5 / Sonnet 4.6 via 9router combo)
- Response validation + auto-retry for proxy issues
- Default model: MODEL_SWE_1_6_FAST (free-tier compatible)

## Breaking Changes
None — backward compatible.
"

# Option B: GitHub Web UI
# → github.com/SammySnake-d/fast-context-mcp/releases/new
# Tag: v1.3.0, Target: main, Title: v1.3.0
# Paste release notes

# 4. CI tự động chạy (xem Actions tab)
# Workflow: publish.yml → npm publish --tag latest --access public --provenance
```

**Sau khi CI xong, verify:**
```bash
npm info @sammysnake/fast-context-mcp version
# Expected: 1.3.0

npx @sammysnake/fast-context-mcp --help 2>&1 | head -5
# Hoặc test MCP tool
```

---

### Cách 2: Manual publish (khi CI không khả dụng hoặc cần publish từ local)

**Prerequisites:**
```bash
# Login npm (1 lần duy nhất)
npm login --scope=@sammysnake
# Nhập username, password, OTP (2FA nếu đã bật)

# Verify
npm whoami
# → sammysnake (hoặc tên account owner)
```

**Publish:**
```bash
cd /Users/luisphan/Documents/fast-context-mcp

# 1. Đảm bảo code sạch
git status  # nothing to commit

# 2. Bump version
npm version minor  # → 1.3.0

# 3. Publish
npm publish --access public

# 4. Nếu muốn publish beta/next:
npm version 1.3.0-beta.1
npm publish --tag next --access public
```

---

## Pre-publish Checklist

- [ ] `node --check src/*.mjs` — tất cả file syntax OK
- [ ] Code chạy được: `node src/server.mjs` không crash ngay (MCP server chờ stdio)
- [ ] Version đồng bộ: `package.json` = `server.mjs` McpServer version
- [ ] `package.json` field `files` chứa đúng: `["src/", "README.md", "LICENSE"]`
- [ ] README cập nhật (setup instructions, env vars, tools)
- [ ] Không leak secrets (grep -r "sk-" src/ — chỉ example strings)
- [ ] `npm pack --dry-run` — xem files sẽ publish, không có garbage

## Troubleshooting

| Vấn đề | Giải pháp |
|---------|-----------|
| `E401 Unauthorized` khi publish local | `npm login --scope=@sammysnake` lại |
| CI fail `npm ERR! 403` | Check npm org permissions cho GitHub Actions |
| `ENEEDAUTH` | Thêm `NPM_TOKEN` secret trong repo Settings → Secrets (nếu không dùng OIDC) |
| Version conflict `E409` | Version đã publish, cần bump lên version mới |
| `files` trong package quá lớn | Kiểm tra `.npmignore` hoặc `files` field trong package.json |

## Sau khi publish thành công

1. Test ngay: `npx -y @sammysnake/fast-context-mcp@latest` trong MCP client config
2. Update Kiro MCP config nếu đang chạy từ source → đổi sang npx
3. Thông báo users (nếu có) về features mới

## Notes

- Package hiện dùng **GitHub OIDC provenance** → npm hiển thị ✓ verified provenance. Đây là best practice, nên ưu tiên Cách 1.
- Scoped package `@sammysnake/` cần `--access public` vì mặc định scoped = private.
- Workflow support cả `latest` tag (stable) và `next` tag (beta) — dùng cho pre-release testing.
