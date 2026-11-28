# Levanto Quartz — forms app, admin panel and API in one image.
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY admin/package*.json admin/
RUN cd admin && npm ci
COPY server/package*.json server/
RUN cd server && npm ci
COPY admin admin
COPY server server
RUN cd admin && npm run build
RUN cd server && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production TZ=Asia/Kolkata
WORKDIR /app
COPY --from=build /src/server/package.json ./
COPY --from=build /src/server/node_modules node_modules
COPY --from=build /src/server/dist dist
COPY --from=build /src/server/legacy legacy
COPY --from=build /src/server/legacy-dashboard legacy-dashboard
COPY --from=build /src/server/monosheets monosheets
COPY --from=build /src/server/legacy-marketing legacy-marketing
COPY --from=build /src/server/migrations migrations
COPY --from=build /src/server/public public
RUN mkdir -p /data && chown node:node /data
USER node
ENV DATA_DIR=/data PORT=8080
EXPOSE 8080
CMD ["node", "dist/index.js"]
