FROM node:22-bookworm-slim

ENV npm_config_update_notifier=false \
    npm_config_fund=false

WORKDIR /probe

COPY container/probe-codex-version.mjs /opt/cell06/probe-codex-version.mjs

RUN mkdir -p /opt/cell06 \
 && if npm install --global @openai/codex; then \
      printf '{"status":"installed"}\n' > /opt/cell06/install-status.json; \
    else \
      code=$?; \
      printf '{"status":"install_failed","exitCode":%s}\n' "$code" > /opt/cell06/install-status.json; \
    fi

CMD ["node", "/opt/cell06/probe-codex-version.mjs"]
