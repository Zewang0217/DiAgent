FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim AS runtime

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap ca-certificates curl git python-is-python3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist

FROM runtime AS service

EXPOSE 8000
ENTRYPOINT ["node", "dist/service/server.js"]

# 默认构建仍生成一次性任务镜像，沿用既有构建入口。
FROM runtime AS task

RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-arphic-gbsn00lp fonts-arphic-bsmi00lp fonts-liberation2 python3-venv \
    && python3 -m venv /opt/diagent-office \
    && /opt/diagent-office/bin/pip install --no-cache-dir python-docx==1.2.0 python-pptx==1.0.2 openpyxl==3.1.5 \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/opt/diagent-office/bin:${PATH}"

RUN mkdir -p -m 0700 /run/diagent
LABEL org.hqit.diagent.task-tool-selection="1"
LABEL org.hqit.diagent.task-model-refresh="1"
LABEL org.hqit.diagent.model-socket="1"
LABEL org.hqit.diagent.task-subagents="1"
LABEL org.hqit.diagent.task-subagent-resources="1"
ENTRYPOINT ["node", "--disable-sigusr1", "dist/task/main.js"]

# 原生 Office 任务镜像使用系统 LibreOffice，移除 SDK 自带的重复 Office 后端。
FROM runtime AS office-task
COPY docker/agent-task-office/prune-sdk-office.mjs ./prune-sdk-office.mjs
RUN node ./prune-sdk-office.mjs && rm ./prune-sdk-office.mjs
