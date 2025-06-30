# Use the official Node.js image as a base image
FROM node:18

# Set the working directory
WORKDIR /usr/src/app

# Install system dependencies, including WebGL support
RUN apt-get update && \
  apt-get install -y \
  ffmpeg \
  libnss3 \
  libxss1 \
  libasound2 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libxkbcommon-x11-0 \
  libgbm-dev \
  libgl1-mesa-dri \
  libgl1-mesa-glx \
  mesa-utils \
  xvfb \
  wget \
  gnupg \
  xorg \
  xserver-xorg \
  libx11-dev \
  libxext-dev \
  && rm -rf /var/lib/apt/lists/*

# Install Google Chrome
RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - && \
  echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list && \
  apt-get update && apt-get install -y google-chrome-stable && \
  rm -rf /var/lib/apt/lists/*

# Copy Chrome enterprise policy
RUN mkdir -p /etc/opt/chrome/policies/managed
COPY auto_launch_protocols.json /etc/opt/chrome/policies/managed/auto_launch_protocols.json

# Install nodemon globally
RUN npm install -g nodemon

# Copy package.json and package-lock.json
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Install Playwright and its dependencies
RUN npx playwright install --with-deps

# Copy the rest of the application code
COPY . .

# Set permissions
RUN chmod +x /usr/src/app/xvfb-run-wrapper

# Build the TypeScript code
RUN npm run build

# Expose the port your app runs on
EXPOSE 3000

# Set Tini as the entry point
ENTRYPOINT ["/usr/src/app/xvfb-run-wrapper"]

CMD ["node", "dist/index.js"]
