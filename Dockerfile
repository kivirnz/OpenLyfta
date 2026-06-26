FROM node:20-bookworm-slim

ENV NODE_ENV=production PORT=3000 DATA_DIR=/data

# Install Caddy + fonts for SVG text rendering inside sharp/librsvg
RUN apt-get update && apt-get install -y --no-install-recommends \
    fontconfig fonts-dejavu fonts-noto-core \
    caddy supervisor \
    make g++ python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY assets ./assets
COPY Caddyfile /etc/caddy/Caddyfile
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Install the bundled Google Sans so librsvg can find it
RUN mkdir -p /usr/share/fonts/truetype/opensans && \
    cp assets/font/google_sans.ttf /usr/share/fonts/truetype/opensans/GoogleSans-Regular.ttf && \
    fc-cache -f

VOLUME ["/data"]
EXPOSE 80
CMD ["supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]