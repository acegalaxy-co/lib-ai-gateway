# Harness vars — giá trị riêng của repo này

Skill/rule chung (tầng máy `~/.claude`) đọc giá trị riêng repo ở bảng dưới thay cho token bake. `install.sh` ghi đè file này mỗi lần cài; đổi giá trị → chạy lại `install.sh` với `HARNESS_BRANCH` / `HARNESS_TEST_CMD` / `HARNESS_PROJECT_SLUG`, không sửa tay. `TEST_CMD` = `none` → chưa cấu hình.

| key | value |
|---|---|
| BRANCH | main |
| TEST_CMD | npm test |
| PROFILE_SLUG | libaigateway |
| PROJECT_SLUG | lib-ai-gateway |
