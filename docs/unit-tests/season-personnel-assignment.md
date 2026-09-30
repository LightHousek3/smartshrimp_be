# Unit Test — Phân công và thay nhân sự phụ trách vụ

- Execution date: 2026-09-29
- Test framework: Jest, Supertest
- Targeted result: 3 suites, 39 tests passed
- Full backend result: 7 suites, 57 tests passed
- PostgreSQL verification: assignment partial unique indexes and required columns/enums exist;
  `EXPLAIN (FORMAT JSON)` accepted both task and disease-case handover statements without executing them
- Defect IDs: Không có

## Service — Phân công nhân sự vào vụ

| Test Case ID | Function | Pre-condition | Input/Condition | Expected Result | Actual Result | Type | Status | Execution Date | Defect ID |
|---|---|---|---|---|---|:---:|:---:|---|---|
| SPA-SVC-001 | `assignPersonnel` | Owner sở hữu vụ PLANNING; nhân sự ACTIVE, đúng role, chưa được phân công | TECHNICIAN hợp lệ | Tạo assignment và notification trong transaction; emit sau commit | Đúng expected; Jest PASS | N | P | 2026-09-29 | - |
| SPA-SVC-002 | `assignPersonnel` | Owner sở hữu vụ ACTIVE | TECHNICIAN hợp lệ | Cho phép phân công | Đúng expected; Jest PASS | B | P | 2026-09-29 | - |
| SPA-SVC-003 | `assignPersonnel` | Vụ không thuộc Owner hoặc không tồn tại | `seasonId` ngoài scope | Trả 404; không kiểm tra/tạo nhân sự | Đúng expected; Jest PASS | A | P | 2026-09-29 | - |
| SPA-SVC-004 | `assignPersonnel` | Vụ COMPLETED | Dữ liệu nhân sự hợp lệ | Trả 409; không tạo assignment | Đúng expected; Jest PASS | A | P | 2026-09-29 | - |
| SPA-SVC-005 | `assignPersonnel` | Vụ CANCELLED | Dữ liệu nhân sự hợp lệ | Trả 409; không tạo assignment | Đúng expected; Jest PASS | A | P | 2026-09-29 | - |
| SPA-SVC-006 | `assignPersonnel` | Vụ hợp lệ | Nhân sự không ACTIVE/không thuộc Owner/sai role | Trả 404; không tạo assignment | Đúng expected; Jest PASS | A | P | 2026-09-29 | - |
| SPA-SVC-007 | `assignPersonnel` | Role đã có assignment hiện tại | Gán thêm người cùng role | Trả 409 và yêu cầu dùng chức năng thay người | Đúng expected; Jest PASS | A | P | 2026-09-29 | - |
| SPA-SVC-008 | `assignPersonnel` | Nhân sự đã giữ role khác trong cùng vụ | Gán thêm role mới | Trả 409; không tạo assignment | Đúng expected; Jest PASS | A | P | 2026-09-29 | - |
| SPA-SVC-009 | `assignPersonnel` | Transaction phát sinh Prisma P2002 | Race unique assignment | Trả 409; không emit realtime | Đúng expected; Jest PASS | A | P | 2026-09-29 | - |
| SPA-SVC-010 | `assignPersonnel` | Transaction phát sinh Prisma P2003 | Race quan hệ FK | Trả 409; không emit realtime | Đúng expected; Jest PASS | A | P | 2026-09-29 | - |
| SPA-SVC-011 | `assignPersonnel` | Transaction phát sinh Prisma P2034 | Serializable conflict | Trả 409; không emit realtime | Đúng expected; Jest PASS | A | P | 2026-09-29 | - |

## Service — Thay nhân sự phụ trách vụ

| Test Case ID | Function | Pre-condition | Input/Condition | Expected Result | Actual Result | Type | Status | Execution Date | Defect ID |
|---|---|---|---|---|---|:---:|:---:|---|---|
| SPR-SVC-001 | `replacePersonnel` | Vụ PLANNING; có KTV hiện tại; KTV mới hợp lệ | Thay TECHNICIAN | Đóng assignment cũ, tạo/link assignment mới, chuyển task PENDING/IN_PROGRESS, thông báo hai người | Đúng expected; Jest PASS | N | P | 2026-09-29 | - |
| SPR-SVC-002 | `replacePersonnel` | Vụ hợp lệ; có Expert hiện tại; Expert mới hợp lệ | Thay EXPERT | Chuyển disease case chưa RESOLVED; không chuyển task; giữ lịch sử | Đúng expected; Jest PASS | N | P | 2026-09-29 | - |
| SPR-SVC-003 | `replacePersonnel` | Vụ COMPLETED | Dữ liệu thay thế hợp lệ | Trả 409; không thay assignment | Đúng expected; Jest PASS | A | P | 2026-09-29 | - |
| SPR-SVC-004 | `replacePersonnel` | Vụ CANCELLED | Dữ liệu thay thế hợp lệ | Trả 409; không thay assignment | Đúng expected; Jest PASS | A | P | 2026-09-29 | - |
| SPR-SVC-005 | `replacePersonnel` | Assignment hiện tại đã đổi/không còn hiệu lực | `expectedAssignmentId` cũ | Trả 409; không kiểm tra nhân sự mới | Đúng expected; Jest PASS | A | P | 2026-09-29 | - |
| SPR-SVC-006 | `replacePersonnel` | Có assignment hiện tại | Nhân sự mới trùng người hiện tại | Trả 409; không thay assignment | Đúng expected; Jest PASS | A | P | 2026-09-29 | - |
| SPR-SVC-007 | `replacePersonnel` | Có assignment hiện tại | Nhân sự mới không ACTIVE/không thuộc Owner/sai role | Trả 404; không thay assignment | Đúng expected; Jest PASS | A | P | 2026-09-29 | - |
| SPR-SVC-008 | `replacePersonnel` | Nhân sự mới đã giữ role khác trong vụ | Thay bằng nhân sự đó | Trả 409; không thay assignment | Đúng expected; Jest PASS | A | P | 2026-09-29 | - |
| SPR-SVC-009 | `replacePersonnel` | Assignment đổi đồng thời trước bước đóng | `updateMany.count = 0` | Trả 409; không tạo assignment mới/notification | Đúng expected; Jest PASS | A | P | 2026-09-29 | - |
| SPR-SVC-010 | `replacePersonnel` | Không ghi được liên kết lịch sử sau khi tạo mới | Link `replacedByAssignmentId` thất bại | Transaction lỗi 409; không bàn giao/notification | Đúng expected; Jest PASS | A | P | 2026-09-29 | - |
| SPR-SVC-011 | `replacePersonnel` | Transaction phát sinh Prisma P2002 | Race unique assignment | Trả 409; không emit realtime | Đúng expected; Jest PASS | A | P | 2026-09-29 | - |
| SPR-SVC-012 | `replacePersonnel` | Transaction phát sinh Prisma P2003 | Race quan hệ FK | Trả 409; không emit realtime | Đúng expected; Jest PASS | A | P | 2026-09-29 | - |
| SPR-SVC-013 | `replacePersonnel` | Transaction phát sinh Prisma P2034 | Serializable conflict | Trả 409; không emit realtime | Đúng expected; Jest PASS | A | P | 2026-09-29 | - |

## Validator

| Test Case ID | Function | Pre-condition | Input/Condition | Expected Result | Actual Result | Type | Status | Execution Date | Defect ID |
|---|---|---|---|---|---|:---:|:---:|---|---|
| SPA-VAL-001 | `assignPersonnel` validator | UUID hợp lệ | role TECHNICIAN | Validation pass | Đúng expected; Jest PASS | N | P | 2026-09-29 | - |
| SPA-VAL-002 | `assignPersonnel` validator | UUID hợp lệ | role EXPERT | Validation pass | Đúng expected; Jest PASS | N | P | 2026-09-29 | - |
| SPA-VAL-003 | `assignPersonnel` validator | Không có | UUID sai, role FARM_OWNER, field lạ | Validation fail 400 ở middleware | Đúng expected; Jest PASS | A | P | 2026-09-29 | - |
| SPR-VAL-001 | `replacePersonnel` validator | UUID hợp lệ | role TECHNICIAN; reason có khoảng trắng biên | Validation pass và trim reason | Đúng expected; Jest PASS | N | P | 2026-09-29 | - |
| SPR-VAL-002 | `replacePersonnel` validator | UUID hợp lệ | role EXPERT; reason có khoảng trắng biên | Validation pass và trim reason | Đúng expected; Jest PASS | N | P | 2026-09-29 | - |
| SPR-VAL-003 | `replacePersonnel` validator | UUID hợp lệ | reason chỉ có khoảng trắng | Validation fail | Đúng expected; Jest PASS | B | P | 2026-09-29 | - |
| SPR-VAL-004 | `replacePersonnel` validator | UUID hợp lệ | reason dài đúng 2000 ký tự | Validation pass | Đúng expected; Jest PASS | B | P | 2026-09-29 | - |
| SPR-VAL-005 | `replacePersonnel` validator | UUID hợp lệ | reason dài 2001 ký tự | Validation fail | Đúng expected; Jest PASS | B | P | 2026-09-29 | - |
| SPR-VAL-006 | `replacePersonnel` validator | Không có | role sai, assignment UUID sai, field lạ | Validation fail 400 ở middleware | Đúng expected; Jest PASS | A | P | 2026-09-29 | - |

## HTTP API — Supertest

| Test Case ID | Function | Pre-condition | Input/Condition | Expected Result | Actual Result | Type | Status | Execution Date | Defect ID |
|---|---|---|---|---|---|:---:|:---:|---|---|
| SPA-API-001 | POST phân công | Bearer Owner hợp lệ; service thành công | Body assignment hợp lệ | HTTP 201, envelope chuẩn, truyền đúng input/owner vào service | Đúng expected; Supertest PASS | N | P | 2026-09-29 | - |
| SPR-API-001 | POST thay người | Bearer Owner hợp lệ; service thành công | Params/body hợp lệ; reason có khoảng trắng biên | HTTP 200, envelope chuẩn, reason được trim | Đúng expected; Supertest PASS | N | P | 2026-09-29 | - |
| SP-API-002 | Cả hai API | Bearer Owner hợp lệ | UUID/role/reason không hợp lệ | HTTP 400 trước service | Đúng expected; Supertest PASS | A | P | 2026-09-29 | - |
| SP-API-003 | Cả hai API | Không có token | Body hợp lệ | HTTP 401 | Đúng expected; Supertest PASS | A | P | 2026-09-29 | - |
| SP-API-004 | Cả hai API | Bearer TECHNICIAN | Body hợp lệ | HTTP 403 | Đúng expected; Supertest PASS | A | P | 2026-09-29 | - |
| SPR-API-005 | POST thay người | Bearer Owner; service trả ApiError conflict | Assignment hiện tại đã thay đổi | Giữ nguyên HTTP 409 và message nghiệp vụ | Đúng expected; Supertest PASS | A | P | 2026-09-29 | - |

## Commands executed

```text
npm.cmd test -- --runInBand test/services/season.personnel-assignment.service.test.js test/validators/season.personnel-assignment.validator.test.js test/routes/season.personnel-assignment.route.test.js
npx.cmd prisma validate
npm.cmd test -- --runInBand
npm.cmd run lint
npx.cmd eslint test/services/season.personnel-assignment.service.test.js test/validators/season.personnel-assignment.validator.test.js test/routes/season.personnel-assignment.route.test.js
git diff --check
```
