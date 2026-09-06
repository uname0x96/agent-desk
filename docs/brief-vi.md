# AgentDesk — Hackathon Brief

**Track:** Payment Workflows (Agent-to-Agent payments)
**Tagline:** Nền tảng workflow trading nơi agent thuê agent, trả tiền theo từng lượt gọi, và mọi agent đều có danh tính on-chain chịu trách nhiệm.

---

## 1. Tóm tắt một đoạn

AgentDesk là nền tảng automation workflow cho trading. Người dùng ghép các agent chuyên biệt (lấy dữ liệu, phân tích, kiểm rủi ro, đặt lệnh, thông báo) thành một quy trình của riêng mình. Các agent này do cá nhân hoặc tổ chức bên thứ ba tạo ra và đăng lên marketplace. Mỗi agent có danh tính ERC-8004 gắn với một ví, đặt giá theo lượt gọi, khoá một khoản cọc, và tích luỹ uy tín on-chain. Mỗi lần một node trong workflow chạy là một khoản thanh toán x402 chảy thẳng từ ví người dùng tới ví chủ agent. Lớp thực thi nối vào Binance Agent OS qua sub-account có hạn mức.

---

## 2. Vấn đề

**Với người dùng:** Mọi trading bot hiện nay là một khối đóng. Muốn phân tích tốt hơn thì phải tự viết lại phần phân tích; muốn thêm kiểm soát rủi ro thì phải tự code. Không có cách nào "thuê" một phần năng lực từ người giỏi hơn.

**Với người tạo agent:** Một dev viết được một agent phân tích rất tốt không có kênh nào để bán nó theo từng lượt cho người lạ. Con đường duy nhất là bán tín hiệu qua Telegram, không có trách nhiệm, không có uy tín kiểm chứng được.

**Với hệ sinh thái:** Binance Agent OS đã mở cửa cho agent truy cập trading và market data qua MCP, nhưng phần thanh toán machine-to-machine (x402) và on-chain vẫn đang được bổ sung dần. Lớp "agent trả tiền cho agent" là mảnh còn thiếu để agent thực sự làm việc *cho nhau* chứ không chỉ cho người dùng.

---

## 3. Vì sao là bây giờ

- **Binance Agent OS** (ra mắt 20/08/2026) định vị rõ: agent được trade, đọc market data, và sắp tới là thanh toán qua x402. Developer đặt quyền, hạn mức, và thu hồi bất cứ lúc nào.
- **ERC-8004** đã có ~200.000 agent đăng ký trên BNB Smart Chain, chiếm phần lớn số agent trên các chain. Danh tính và uy tín on-chain cho agent không còn là ý tưởng, đã là hạ tầng.
- **BNB Chain** đang tích cực tìm marketplace agent chính thức cho BNB Agent Studio. Một sản phẩm đúng hướng có đường đi tiếp sau hackathon.

---

## 4. Giải pháp

### 4.1 Ba lớp kiến trúc

**Lớp 1 — Danh tính & tiền**
- Mỗi agent đăng ký một bản ghi ERC-8004, trỏ tới ví nhận tiền của chủ sở hữu.
- Chủ agent khoá một khoản cọc khi niêm yết. Cọc là nguồn hoàn tiền khi agent giao kết quả kém.
- Người dùng có ví riêng cho workflow, với ngân sách theo ngày.
- Uy tín của agent được ghi on-chain sau mỗi vòng settlement.

**Lớp 2 — Marketplace**
- Mỗi agent được niêm yết với: loại (`data` / `research` / `risk` / `execution` / `notify`), input/output schema chuẩn hoá theo loại, giá mỗi lượt, cọc, uy tín, chủ sở hữu.
- Schema chuẩn hoá theo loại là điểm cốt lõi: nó cho phép agent của người lạ cắm vào workflow của bất kỳ ai mà không cần chỉnh code.
- Ai cũng có thể niêm yết agent mới, không cần phê duyệt. Cọc và uy tín thay cho phê duyệt.
- Khi niêm yết, nền tảng gọi thử endpoint một lần với payload mẫu để kiểm tra agent trả đúng schema của loại đã khai. Sai schema thì không cho niêm yết.

**Loại cố định, workflow tự do, provider cạnh tranh**
- *Loại* là ngôn ngữ chung. Chợ chỉ nhận agent thuộc 5 loại chuẩn; không nhận loại tuỳ ý, vì agent có input/output tuỳ ý thì không cắm vào workflow của người lạ được.
- *Workflow* do người dùng tự vẽ từ các loại đó, không phải pipeline cứng. Ví dụ: `data → research → execution`; `data → research → risk → execution → notify`; `data(giá) + data(tin) → research → risk → execution`; `data → research A + research B → risk → execution`; hoặc `data → research → notify` để chỉ theo dõi.
- *Provider*: ở mỗi node, người dùng chọn một agent trong nhiều agent cùng loại trên chợ. Hai mươi Research agent khác nhau hoàn toàn về cách phân tích nhưng cùng nhận một input và trả một output, nên đổi provider chỉ là một cú click, workflow không đổi.
- Loại tuỳ chỉnh (creator tự khai schema, engine chỉ cho nối khi output khớp input) để dành cho phiên bản sau.

**Lớp 3 — Workflow engine**
- Người dùng ghép các node thành đồ thị. Mỗi node là một agent thuê từ chợ.
- Trước khi chạy, engine tính chi phí tối đa của workflow và khoá giá từng node tại thời điểm chạy.
- Mỗi lần node chạy là một handshake x402: gọi endpoint → nhận 402 → đối chiếu giá → ký thanh toán → nhận kết quả.
- Node `execution` nối vào Binance Agent OS (MCP) qua sub-account có hạn mức do người dùng đặt.

### 4.2 Định giá: theo lượt gọi

Mỗi agent có đúng một con số `price_per_call` (USDT). Đơn giản, khớp hoàn toàn với x402 (mỗi request = một 402 = một khoản cố định), và đủ cho hackathon. Các mô hình khác (theo tài nguyên, theo kết quả, thuê bao) để dành cho roadmap.

Chi tiết quan trọng: chủ agent đổi giá được bất cứ lúc nào, nhưng workflow **khoá giá tại thời điểm chạy**. Nếu 402 trả về số tiền khác giá đã khoá, engine từ chối. Đây là chốt chặn chống agent tự tăng giá giữa chừng.

### 4.3 Cọc, uy tín, settlement

- Uy tín = tỉ lệ kết quả đạt trong N lượt gần nhất (N = 30 cho MVP).
- Sau mỗi vòng, một settlement job đối chiếu kết quả với thực tế. Với `research`: giá sau 1 giờ có đi đúng hướng tín hiệu không. Với `risk`: lệnh được duyệt có gây drawdown vượt ngưỡng không.
- Kết quả sai rõ ràng → trừ từ cọc để hoàn một phần phí cho người dùng, uy tín giảm.
- Cọc cạn → agent bị tạm dừng niêm yết cho tới khi nạp lại.

Đây là thứ biến "trả tiền cho agent" thành "trả tiền cho agent chịu trách nhiệm".

### 4.4 Một vòng chạy mẫu

Người dùng: *"Theo dõi BNB/USDT, vào lệnh khi có cơ hội, tối đa 100 USDT."*

1. Engine tính chi phí workflow: Research 0.05 + Risk 0.02 = 0.07 USDT/lượt. Trong ngân sách, cho chạy.
2. Node Research: gọi endpoint → 402 kèm 0.05 USDT → đối chiếu khớp giá khoá → ký thanh toán → nhận `{signal: LONG, confidence: 0.72, reason: ...}`.
3. Node Risk: gửi lệnh dự kiến + số dư → 402 kèm 0.02 USDT → thanh toán → nhận `{decision: REDUCE, size: 60, reason: "biến động 24h cao"}`.
4. Node Execution: đặt lệnh 60 USDT qua Binance MCP trong sub-account, trả về order ID.
5. Node Notify: gửi tóm tắt cho người dùng kèm bảng chi phí và tx hash.
6. Sau 1 giờ, settlement chấm Research. Đúng → uy tín tăng. Sai → trừ cọc, hoàn tiền, uy tín giảm.

---

## 5. Vì sao cần agent-to-agent (thay vì một backend bình thường)

Bài kiểm tra: *nếu một công ty có thể sở hữu cả hai đầu giao dịch và sẵn lòng làm, thì không cần A2A.* AgentDesk vượt bài kiểm tra này ở cả bốn điểm:

1. **Người trả tiền là máy.** Workflow chạy 3 giờ sáng, không ai bấm xác nhận. Cần ví riêng, hạn mức riêng, rail thanh toán không cần OTP.
2. **Đối tác không quen biết trước.** Agent trên chợ do người lạ tạo. Không có hợp đồng, không có API key, không tích hợp trước. Cắm vào là chạy, trả tiền là xong.
3. **Không có trung gian giữ tiền.** Tiền đi thẳng từ ví người dùng tới ví chủ agent. Nền tảng chỉ thu phí phần trăm, không giữ tiền của ai.
4. **Giao dịch nhỏ và nhiều.** 0.02 USDT mỗi lượt, hàng trăm lượt mỗi ngày. Thẻ và ngân hàng không làm được.

Nếu tất cả nằm trong một backend thì không có "chợ", chỉ có một bot có năm hàm.

---

## 6. Người dùng mục tiêu

**Workflow builder** — trader bán chuyên, biết mình muốn gì nhưng không muốn code. Ghép agent có sẵn, đặt ngân sách, chạy.

**Agent creator** — dev hoặc quỹ nhỏ có một năng lực cụ thể (phân tích on-chain, đọc tin, mô hình rủi ro). Niêm yết agent, đặt giá, kiếm tiền thụ động theo lượt, xây uy tín on-chain.

**Hệ sinh thái** — Binance/BNB Chain có thêm lý do để agent giao dịch qua Agent OS, và có thêm khối lượng x402.

---

## 7. Mô hình kinh doanh

- Phí nền tảng 2–5% trên mỗi lượt x402.
- Hiệu ứng mạng hai chiều: nhiều agent → workflow tốt hơn → nhiều người dùng → agent creator kiếm được nhiều hơn → nhiều agent.
- Nền tảng không giữ tiền, không chịu rủi ro custody.

---

## 8. Stack kỹ thuật (đề xuất)

| Thành phần | Lựa chọn |
|---|---|
| Chain | BSC testnet hoặc opBNB (phí gần 0, phù hợp micro-payment) |
| Thanh toán | x402, USDT. Facilitator tự chạy cho MVP; cắm facilitator của Binance khi họ mở |
| Danh tính | ERC-8004 registry |
| Registry marketplace | Contract nhỏ: niêm yết, giá, cọc, uy tín |
| Market data & đặt lệnh | Binance Agent OS (MCP), sub-account có hạn mức, Emergency Stop |
| Agent | Mỗi agent là một HTTP service nhỏ, dùng LLM cho phân tích/giải thích |
| Workflow engine | Node service, chạy DAG tuần tự cho MVP |
| UI | React + react-flow (hoặc JSON editor có preview đồ thị) |

### Bản ghi agent (tối thiểu)

```
agent_id          // id trong ERC-8004
owner_wallet      // ví nhận tiền
endpoint          // URL agent
type              // data | research | risk | execution | notify
input_schema
output_schema
price_per_call    // USDT
stake             // cọc đã khoá
reputation        // điểm hiện tại
```

### Luồng một lượt gọi

1. Engine đọc `price_per_call`, cộng vào tổng chi phí. Vượt trần → dừng trước khi gọi.
2. Gọi `endpoint` → nhận 402 kèm yêu cầu thanh toán (số tiền, ví nhận, chain).
3. Đối chiếu số tiền với giá đã khoá lúc chạy. Lệch → từ chối.
4. Ký thanh toán, gọi lại kèm chứng từ, nhận kết quả.
5. Ghi log: node, số tiền, tx hash, kết quả.

---

## 9. Phạm vi hackathon (MVP)

**Làm:**
- Một workflow mẫu xuyên suốt: Data → Research → Risk → Execution → Notify.
- Marketplace có sẵn 4–5 agent, trong đó **hai Research cạnh tranh nhau** (một tử tế, một cố tình ẩu để demo refund).
- Đúng một luồng "niêm yết agent mới": nhập endpoint + schema + giá → đăng ký ERC-8004 → khoá cọc → xuất hiện trên chợ ngay.
- Thanh toán x402 thật trên testnet, có tx hash.
- Settlement đơn giản: giá sau 1 giờ đúng hướng hay không (demo dùng khung thời gian rút ngắn).
- Dashboard hiện mọi cuộc gọi và mọi khoản tiền.

**Không làm:**
- Rẽ nhánh phức tạp, lập lịch, backtest, versioning workflow.
- Xử lý tranh chấp, quản trị.
- Đa chain, multi-asset.
- Kéo-thả đẹp. Đồ thị đọc được là đủ.

**Thứ tự ưu tiên khi thiếu thời gian:**
1. Registry contract + một agent trả 402 + engine gọi được và trả tiền được. (Xương sống)
2. Workflow chạy hết 5 node, lệnh vào Binance testnet.
3. Luồng niêm yết agent mới.
4. Settlement + refund.
5. Dashboard.

Nếu chỉ kịp 1 và 2, vẫn có bài. Nếu kịp 3, đó là nền tảng. Nếu kịp 4, đó là nền tảng có trách nhiệm.

---

## 10. Kịch bản demo (3 phút)

Màn hình chia hai: trái là log các agent trao đổi, phải là dòng tiền.

**0:00** — Mở chợ, chọn agent, ghép thành workflow. Màn hình hiện "tối đa 0.07 USDT/lượt".

**0:30** — Bấm chạy. Từng node sáng lên, bên phải hiện từng khoản chảy tới ví chủ agent kèm tx hash. Lệnh vào Binance testnet.

**1:20** — *Khoảnh khắc nền tảng.* Mở tab thứ hai, đóng vai một dev lạ, niêm yết một Research Agent mới trong 30 giây: endpoint, giá 0.03 USDT, khoá cọc. Không ai phê duyệt.

**1:50** — Quay lại tab một, thay node Research bằng agent vừa niêm yết. Chạy lại. Tiền chảy tới ví của "dev lạ".

**2:20** — Agent mới đưa tín hiệu ẩu. Risk từ chối. Settlement chấm sai, trừ cọc, hoàn tiền người dùng, uy tín tụt xuống dưới agent cũ.

**2:50** — Kết: *"Đây là cách agent thuê agent mà vẫn có người chịu trách nhiệm."*

Tab thứ hai là toàn bộ lý do gọi đây là nền tảng. Cú refund là khoảnh khắc ăn điểm, vì đa số đội chỉ demo happy path.

---

## 11. Rủi ro & phương án dự phòng

| Rủi ro | Phương án |
|---|---|
| x402 của Binance chưa có testnet hoặc facilitator công khai | Dùng x402 chuẩn trên BSC testnet với facilitator tự viết. Nói rõ trong pitch sẽ cắm facilitator Binance khi mở. |
| Binance MCP không chạy trên Spot Testnet | Node Execution gọi Binance Spot Testnet API trực tiếp. Giữ MCP cho phần market data. |
| Faucet hết tiền / RPC lag đúng lúc demo | Chuẩn bị 2–3 ví đã nạp sẵn. Ghi màn hình dự phòng. |
| Settlement "đúng hướng sau 1 giờ" bị vặn là quá đơn giản | Thừa nhận thẳng: MVP dùng luật đơn giản để chứng minh cơ chế; roadmap là Judge agent độc lập và luật theo từng loại agent. |
| Bị hỏi "sao không dùng backend thường" | Slide "Why not a normal backend?" ba dòng, xem mục 5. |
| Phạm vi phình | Bám thứ tự ưu tiên ở mục 9. Cắt từ dưới lên. |

---

## 12. Câu hỏi giám khảo có thể hỏi

- **Tại sao không dùng Binance Pay?** Pay là người-với-doanh-nghiệp và cần merchant đăng ký. AgentDesk là máy-với-máy, đối tác là agent lạ, không có merchant nào để đăng ký.
- **Agent ẩu thì sao?** Cọc + uy tín + settlement. Xem mục 4.3 và demo phút 2:20.
- **Chủ agent tăng giá giữa chừng?** Giá khoá tại thời điểm chạy, engine từ chối 402 lệch giá.
- **Ai giữ tiền?** Không ai. Tiền đi thẳng ví-tới-ví, nền tảng chỉ thu phí.
- **Khác gì một chợ agent thường?** Lớp workflow. Chợ bán agent, AgentDesk bán *quy trình ghép từ agent*, và mỗi quy trình là một đồ thị thanh toán tính được trước.

---

## 13. Roadmap sau hackathon

- Judge agent độc lập cho settlement, luật riêng theo từng loại agent.
- Định giá theo kết quả (trả thêm nếu tín hiệu đúng).
- Workflow có rẽ nhánh, lập lịch, versioning.
- Niêm yết trên BNB Agent Studio.
- Mở rộng ngoài trading: cùng engine, khác loại agent.

---

## 14. Việc cần chốt trước khi code

- Stack của team: Node hay Python; Solidity với Foundry hay Hardhat.
- Xác nhận x402 của Binance settle trên chain nào, có testnet không.
- Xác nhận Binance MCP có chạy được với Spot Testnet không.
- Phân công: ai làm contract, ai làm engine + agent mẫu, ai làm UI + demo.
