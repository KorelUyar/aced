# The share service behind Aced's "Copy link" (server.js): Node only, no packages.
#
#   docker build -t aced-share service
#   docker run -d --name aced-share --restart unless-stopped --network host \
#     -v aced-share-data:/data aced-share
#
# It listens on 127.0.0.1:8790 of the machine (the host's network, the container's loopback is
# the machine's), so only what runs on the machine reaches it: put it behind HTTPS there (a
# reverse proxy or a tunnel) and set the app's link address (src/link.js, HOST) to that address.
# Behind a proxy on the machine that names the visitor in a header it sets itself, add
#   -e CLIENT_IP_HEADER=cf-connecting-ip -e TRUSTED_PROXIES=127.0.0.1,::1
# so the limits count per visitor (see server.js). Never publish the port on other addresses.
FROM node:22-alpine
WORKDIR /app
COPY server.js page.html page.js page.css icon.svg ./
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production BIND=127.0.0.1 PORT=8790 DATA_DIR=/data
VOLUME /data
EXPOSE 8790
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8790/healthz || exit 1
CMD ["node", "server.js"]
