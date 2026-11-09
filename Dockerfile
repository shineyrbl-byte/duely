# Container for Hugging Face Spaces (or any Docker host).
FROM node:22-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=7860 HOSTNAME=0.0.0.0
EXPOSE 7860
CMD ["npm", "start"]
