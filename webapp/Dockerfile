FROM node:24-alpine

WORKDIR /app
COPY . .

ENV PORT=5188
ENV CUSTOMER_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 5188

CMD ["node", "server.js"]
