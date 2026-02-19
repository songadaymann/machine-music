FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY server/ server/
COPY client/ client/
COPY public/ public/
COPY .claude/skills/ .claude/skills/

EXPOSE 8080

CMD ["bun", "run", "server/index.ts"]
