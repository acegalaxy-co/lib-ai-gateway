# /deploy-production reboot — Khôi phục out-of-band cho host prod bị wedged

Mode của skill [deploy-production](SKILL.md). Confirmation gate + bước 0 (Project guard) nằm ở SKILL.md — làm trước, rồi mới theo file này.

Dùng khi `<deploy-ssh-host>` **bị wedged ở tầng userspace**: TCP port accept nhanh nhưng không
service nào trả data — `ssh` treo ở "banner exchange", healthcheck timeout (HTTP `000`).
Kernel vẫn sống (TCP SYN có trả lời) nhưng userspace bị đói tài nguyên — gần như luôn do **disk full (ENOSPC)**
vì Docker build cache lấp đầy `/`. SSH không truy cập được, nên đòn bẩy duy nhất còn lại là **reboot
out-of-band** qua API/console của provider.

> ⛔ **QUY TẮC CỨNG**
> - **Chỉ reboot** — không bao giờ stop/start instance nếu IP public không được đảm bảo static
>   (stop/start có thể đổi IP và làm hỏng DNS/truy cập). Nếu provider đảm bảo static IP,
>   xác nhận điều đó trước khi cân nhắc stop/start; mặc định dùng reboot.
> - **KHÔNG BAO GIỜ xoá data** — reboot giữ nguyên root disk + named volume. Không `down -v` /
>   `docker volume rm` / `rm -rf` bất cứ gì.
> - Reboot gây **downtime cho mọi service trên host**. Production → xác nhận với user
>   trước khi issue lệnh reboot.

## Các bước

0. **Project guard** — bước 0 của [SKILL.md](SKILL.md) (config cần: host, service). Fail → STOP, không chạy reboot.

1. **Xác nhận host thật sự bị wedged (không chỉ chậm).** Từ local, probe TCP + SSH banner:
   ```bash
   ssh -o ConnectTimeout=15 <deploy-ssh-host> 'echo SSH_OK; uptime' 2>&1 | head -2
   ```
   - **Nếu SSH trả về `SSH_OK`** → host KHÔNG bị wedged. **Không** reboot. Chạy
     `/deploy-production cleanup` ([cleanup.md](cleanup.md)) thay thế (nhiều khả năng chỉ là disk pressure).
   - Dấu hiệu wedged: port mở (TCP connect được) nhưng SSH banner-timeout và healthcheck timeout.

2. **Reboot out-of-band — ví dụ, tự điều chỉnh theo cloud provider của bạn.** SSH/console không truy cập được, nên
   phải đi qua control-plane API của provider. Ví dụ cho AWS EC2 (điều chỉnh instance id,
   region, và auth profile theo setup thật của bạn — không hardcode giá trị thật ở đây):
   ```bash
   # example only — replace <instance-id> / <region> / <profile>
   aws ec2 describe-instance-status --profile <profile> --region <region> \
     --instance-ids <instance-id> \
     --query 'InstanceStatuses[].{State:InstanceState.Name,Inst:InstanceStatus.Status,Sys:SystemStatus.Status}' --output table
   aws ec2 reboot-instances --profile <profile> --region <region> --instance-ids <instance-id>
   ```
   `reboot-instances` (không phải stop/start) giữ nguyên IP. Với provider khác, dùng action
   reboot-only API/console tương đương (không bao giờ dùng stop+start / power-cycle làm đổi IP).

3. **Xác nhận với user trước khi issue lệnh reboot** — đây là production downtime cho mọi
   service trên host. Lấy OK rõ ràng trừ khi đã được pre-authorize.

4. **Poll SSH đến khi host trở lại:**
   ```bash
   for i in $(seq 1 12); do
     if out=$(ssh -o ConnectTimeout=10 <deploy-ssh-host> 'echo SSH_OK; uptime; df -h / | tail -1' 2>/dev/null); then
       echo "UP"; echo "$out"; break
     else echo "attempt $i: not yet"; sleep 15; fi
   done
   ```

5. **Cleanup + verify.** Reboot lấy lại được SSH nhưng KHÔNG tự giải phóng disk — làm tiếp
   [cleanup.md](cleanup.md) để prune build cache/dangling image và verify
   `<service-name>` cùng mọi service khác trên host.

## Guardrails

- Chỉ reboot — không bao giờ stop/start (hoặc tương đương) có thể làm đổi IP host.
- Không bao giờ xoá data: không `down -v`, không `docker volume rm`, không `rm -rf`.
- Xác nhận với user trước khi issue lệnh reboot (production downtime cho toàn bộ host).
- Nếu SSH thực tế vẫn truy cập được, KHÔNG reboot — đi thẳng tới `/deploy-production cleanup`.
