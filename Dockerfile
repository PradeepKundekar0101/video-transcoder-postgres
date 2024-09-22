FROM ubuntu:focal

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y curl ffmpeg git && \
    curl -sL https://deb.nodesource.com/setup_16.x | bash - && \
    apt-get install -y nodejs

WORKDIR /home/app

COPY package*.json .

RUN npm install

COPY src/ src/


ENTRYPOINT [ "node", "src/index.js" ]
