# The share service behind Aced's "Copy link" (server.js): Node only, no packages.
#
#   docker build -t aced-share service
#   docker run -d --name aced-share --restart unless-stopped -p 127.0.0.1:8790:8790 \
#     -v aced-share-data:/data aced-share
#
# Put it behind HTTPS (a reverse proxy or a tunnel) and set the app's link address (src/link.js,
# HOST) to that address. Behind a proxy that names the visitor's address in a header, pass
# -e CLIENT_IP_HEADER=<that header> so the limits count per visitor.
FROM node:22-alpine
WORKDIR /app
COPY server.js page.html page.js page.css icon.svg ./
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production BIND=0.0.0.0 PORT=8790 DATA_DIR=/data
VOLUME /data
EXPOSE 8790
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8790/healthz || exit 1
CMD ["node", "server.js"]
