# SmartShrimp Backend

> Farm Operations Management and Technical Consulting System for Shrimp Farms

The SmartShrimp REST API serves the web portal and mobile app.

## Features

- Manage accounts, farm personnel, farms, ponds, and production cycles.
- Record water quality, shrimp health, daily operations, inventory movements, and harvests.
- Coordinate disease cases and the preparation, approval, and execution of production and treatment protocols.
- Provide dashboards, scheduled reminders, and notifications. Integrate with separate services for image-based disease assessment and document-based assistance.

## Technology

**Node.js · Express · Prisma · PostgreSQL (Supabase) · Redis · Socket.IO**

## Getting started

### Local development

Use Node.js 22 or later and a PostgreSQL database with the SmartShrimp schema already installed.

In `.env`, set `NODE_ENV=development`, `DATABASE_URL`, `JWT_ACCESS_SECRET`, and `JWT_REFRESH_SECRET`. Set `WEB_BASE_URL` and `CORS_ORIGIN` when using a different web origin. Keep credentials in your local environment.

```sh
npm ci
npx prisma generate
npm run dev
```

### Docker Compose

Use Docker Compose 2.30 or later. In `.env.container`, set the database connection, JWT secrets, `WEB_BASE_URL`, and `CORS_ORIGIN`.

Compose starts the API and separate Redis instances for caching and rate limiting. PostgreSQL runs outside the stack.

```sh
docker compose config --quiet
docker compose up --build -d --wait
```

## API reference

The default address is `http://localhost:3000`.

| Path        | Purpose                        |
| ----------- | ------------------------------ |
| `/api/v1`   | REST API prefix                |
| `/api-docs` | Swagger UI                     |
| `/health`   | HTTP liveness                  |
| `/ready`    | Startup and database readiness |

Run `npm run lint` to check the backend source.

## Project team

**Mentor** — Nguyễn Đình Vinh

**Members**

- Phạm Hải Đăng
- Nguyễn Thị Kim Soàn
- Phạm Quốc Tự
- Liêu Tấn Đạt
- Cô Thái Bảo
