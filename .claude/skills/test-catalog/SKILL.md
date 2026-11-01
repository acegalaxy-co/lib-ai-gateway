---
name: test-catalog
description: Sinh lại bảng "Danh mục test (toàn bộ)" trong docs/testing.md từ code test (mọi @Test/@ParameterizedTest/@RepeatedTest, đánh dấu @Disabled). Dùng sau khi thêm/xoá/disable test, hoặc khi user hỏi test nào đã được ghi lại.
---

# test-catalog

1. Chạy từ root repo (hoặc worktree): `python3 .claude/skills/test-catalog/gen.py`
   - In `classes=<n> tests=<n> disabled=<n>`; ghi đè khối giữa `<!-- test-catalog:start -->` và `<!-- test-catalog:end -->` trong `docs/testing.md` (chưa có thì chèn trước `## Giới hạn`).
   - `--check`: exit 1 nếu bảng đã lỗi thời so với code (không ghi file).
2. Commit `docs/testing.md` cùng commit thêm/xoá test. Commit trên `kane-staging-fixbug` tự deploy docs lên gse.acegalaxy.co.
3. Chỉ quét `sources/games/*/src/test/java` (test game) ở repo này; catalog test engine (`gse-*`) nằm ở repo core `ace_engine-ace-server-game` (`${GSE_CORE_REPO:-../ace_engine-ace-server-game}`).
4. Mô tả ý nghĩa test (bug, kịch bản) vẫn viết tay ở các mục trên của `docs/testing.md`; bảng này chỉ đảm bảo không test nào bị sót.
