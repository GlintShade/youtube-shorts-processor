FROM node:18-alpine

# Install dependencies including fonts
RUN apk add --no-cache \
    ffmpeg \
    python3 \
    py3-pip \
    curl \
    font-liberation \
    fontconfig

# Install yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# Update font cache
RUN fc-cache -f

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
