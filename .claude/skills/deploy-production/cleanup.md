# /deploy-production cleanup — Giải phóng disk trên prod host (an toàn, không downtime)

Mode của skill [deploy-production](SKILL.md). Confirmation gate + bước 0 (Project guard) nằm ở SKILL.md — làm trước, rồi mới theo file này.

Docker build cache tích luỹ sau mỗi lần build deploy, cùng với dangling image, có thể lấp đầy
`/` tới gần 100% → ENOSPC → cả host bị kẹt cứng. Mode này giải phóng không gian đó **an toàn, tại
chỗ, không downtime và không mất dữ liệu** — chỉ prune build cache + dangling image, không đụng
volume hay container đang chạy.

> ⛔ **QUY TẮC CỨNG — không đụng dữ liệu:**
> - **KHÔNG BAO GIỜ** chạy `docker system prune --volumes`, `docker volume rm`, `down -v`, `rm -rf`, hoặc `-a`
>   trên image/system prune (có thể xoá image vẫn đang được container đã dừng tham chiếu).
> - Phạm vi prune = **CHỈ build cache + dangling image**. Container đang chạy, named volume, và
>   image đang dùng giữ nguyên, không đụng tới.
> - Không stop/restart/recreate `<service-name>` hay bất kỳ service nào khác trong lúc cleanup.

## Các bước

0. **Project guard** — bước 0 của [SKILL.md](SKILL.md) (config cần: host, service, healthcheck). Fail → STOP, không chạy cleanup.

1. **Đánh giá disk + không gian có thể giải phóng.**
   ```bash
   ssh -o ConnectTimeout=15 <deploy-ssh-host> 'echo "=== DISK ==="; df -h / | tail -1; echo; echo "=== DOCKER DF ==="; docker system df'
   ```
   Báo `Use%` và cột `RECLAIMABLE`. Nếu disk còn thoải mái (< ~75%) và reclaimable
   nhỏ, báo user không có gì đáng prune và dừng.

2. **Prune build cache + dangling image (an toàn — không volume, không `-a`).**
   ```bash
   ssh -o ConnectTimeout=15 <deploy-ssh-host> 'echo "=== builder cache ==="; docker builder prune -af | tail -3; echo "=== dangling images ==="; docker image prune -f | tail -3; echo "=== disk after ==="; df -h / | tail -1'
   ```
   - `docker builder prune -af` → chỉ xoá BuildKit cache (an toàn).
   - `docker image prune -f` (không `-a`) → chỉ xoá dangling image; image được bất kỳ
     container nào tham chiếu, kể cả container đã dừng, vẫn được giữ lại.

3. **Verify service mục tiêu VÀ mọi service khác không bị đụng tới + vẫn healthy.**
   ```bash
   ssh -o ConnectTimeout=15 <deploy-ssh-host> 'docker ps --format "{{.Names}}\t{{.Status}}"'
   ssh -o ConnectTimeout=15 <deploy-ssh-host> '<healthcheck-cmd>'
   ```
   Mọi service trong `docker ps` vẫn phải hiện `Up`/`healthy`, cùng container id như trước (mode
   này không được restart bất cứ gì). Healthcheck của target phải trả về healthy/200.

4. **Báo cáo** disk trước/sau (vd `92% → 71%, freed ~8GB`) và xác nhận mọi service vẫn healthy.

## Guardrails

- CHỈ prune build cache + dangling image. Không bao giờ `--volumes`, không bao giờ `docker volume rm`, không bao giờ `-a`
  trên image prune, không bao giờ `down -v` / `rm -rf`.
- Không bao giờ restart/recreate service nào ở đây — đây là dọn disk, không phải deploy.
- Nếu host bị kẹt cứng hoàn toàn (SSH treo ở banner exchange), cleanup không chạy được — dùng
  `/deploy-production reboot` ([reboot.md](reboot.md)) trước để lấy lại SSH, rồi mới chạy mode này.
