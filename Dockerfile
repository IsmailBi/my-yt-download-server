# Stage 1: Build the Next.js application
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package.json and lock file to install dependencies
COPY package.json yarn.lock* ./
# If you use npm, replace with: COPY package.json package-lock.json ./

# Install Node.js dependencies
RUN yarn install --frozen-lockfile --production=false
# If you use npm, replace with: RUN npm install --omit=dev

# Copy the rest of your application code
COPY . .

# Build the Next.js app for production
RUN yarn build
# If you use npm, replace with: RUN npm npm run build

# Stage 2: Create the production-ready runtime image
FROM node:20-alpine

# Install FFmpeg (Crucial for video merging)
# Alpine Linux uses 'apk' for package management
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Copy only the necessary files from the builder stage
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/public ./public
# If you are using the App Router in Next.js 13/14:
COPY --from=builder /app/app ./app
# REMOVE THIS LINE:
# COPY --from=builder /app/pages ./pages


# --- Port Configuration ---
ENV PORT=5000
EXPOSE 5000

# Command to start the Next.js production server
CMD ["npm", "start"]
# If you used yarn:
# CMD ["yarn", "start"]