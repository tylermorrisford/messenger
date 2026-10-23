# Deploying to Digital Ocean Droplet

This guide walks you through deploying the messaging application to a Digital Ocean droplet with Docker, PostgreSQL, and Nginx.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Create Digital Ocean Droplet](#create-digital-ocean-droplet)
3. [Initial Server Setup](#initial-server-setup)
4. [Install Docker](#install-docker)
5. [Install Nginx](#install-nginx)
6. [Transfer Files to Server](#transfer-files-to-server)
7. [Configure Environment Variables](#configure-environment-variables)
8. [Start the Application](#start-the-application)
9. [Configure Nginx](#configure-nginx)
10. [Set Up SSL (Optional but Recommended)](#set-up-ssl-optional-but-recommended)
11. [Troubleshooting](#troubleshooting)

---

## Prerequisites

- A Digital Ocean account
- A domain name (optional, but recommended for SSL)
- Basic terminal/command line knowledge
- SSH key pair (recommended for secure access)

---

## Create Digital Ocean Droplet

1. **Log in to Digital Ocean** and click "Create" → "Droplets"

2. **Choose an Image**: Ubuntu 22.04 LTS x64 (recommended)

3. **Choose Plan**:
   - Basic plan: $12/month (2 GB RAM, 1 vCPU, 50 GB SSD) - Minimum recommended
   - Or higher for production use

4. **Choose Datacenter Region**: Select closest to your users

5. **Authentication**:
   - Recommended: Add your SSH key
   - Alternative: Use password (less secure)

6. **Finalize**:
   - Choose a hostname (e.g., `messaging-app`)
   - Click "Create Droplet"

7. **Note your Droplet's IP address** - you'll need this throughout the guide

---

## Initial Server Setup

### 1. Connect to Your Droplet

```bash
# Using SSH key
ssh root@YOUR_DROPLET_IP

# Using password (if you didn't add SSH key)
ssh root@YOUR_DROPLET_IP
# Then enter the password sent to your email
```

### 2. Update System Packages

```bash
apt update && apt upgrade -y
```

### 3. Create a Non-Root User (Recommended)

```bash
# Create user
adduser deploy

# Add to sudo group
usermod -aG sudo deploy

# Copy SSH keys to new user (if using SSH)
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
```

### 4. Set Up Firewall

```bash
# Allow OpenSSH
ufw allow OpenSSH

# Allow HTTP
ufw allow 80/tcp

# Allow HTTPS
ufw allow 443/tcp

# Enable firewall
ufw enable

# Check status
ufw status
```

### 5. Switch to Deploy User

```bash
# Exit and reconnect as deploy user
exit
ssh deploy@YOUR_DROPLET_IP
```

---

## Install Docker

### 1. Install Docker Dependencies

```bash
sudo apt update
sudo apt install -y apt-transport-https ca-certificates curl software-properties-common
```

### 2. Add Docker's Official GPG Key

```bash
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
```

### 3. Add Docker Repository

```bash
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
```

### 4. Install Docker

```bash
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
```

### 5. Add User to Docker Group

```bash
sudo usermod -aG docker ${USER}

# Log out and back in for this to take effect
exit
ssh deploy@YOUR_DROPLET_IP
```

### 6. Verify Docker Installation

```bash
docker --version
docker compose version

# Test Docker
docker run hello-world
```

---

## Install Nginx

### 1. Install Nginx

```bash
sudo apt update
sudo apt install -y nginx
```

### 2. Verify Nginx is Running

```bash
sudo systemctl status nginx
```

You should be able to visit `http://YOUR_DROPLET_IP` in a browser and see the Nginx welcome page.

---

## Transfer Files to Server

You have several options for getting your files to the server:

### Option A: Using Git (Recommended)

**1. Install Git on Server**

```bash
sudo apt install -y git
```

**2. Clone Your Repository**

```bash
# If public repository
cd ~
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git
cd YOUR_REPO

# If private repository (you'll need to set up SSH keys or use HTTPS with token)
git clone git@github.com:YOUR_USERNAME/YOUR_REPO.git
```

**3. Navigate to Project**

```bash
cd ~/YOUR_REPO/prisma
```

### Option B: Using SCP (Secure Copy)

**From your local machine**, run:

```bash
# Navigate to your project directory locally
cd /Users/tylerford/Desktop/repo

# Copy entire prisma directory to server
scp -r prisma deploy@YOUR_DROPLET_IP:~/

# This will create ~/prisma on your server
```

### Option C: Using rsync (Better for Large Files)

**From your local machine**, run:

```bash
# Navigate to your project directory locally
cd /Users/tylerford/Desktop/repo

# Sync prisma directory to server
rsync -avz --progress prisma/ deploy@YOUR_DROPLET_IP:~/prisma/

# Exclude node_modules and other unnecessary files
rsync -avz --progress \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude 'dist' \
  --exclude '.git' \
  prisma/ deploy@YOUR_DROPLET_IP:~/prisma/
```

---

## Configure Environment Variables

### 1. Navigate to Project Directory

```bash
cd ~/prisma  # or wherever your project is located
```

### 2. Update Backend .env

```bash
nano .env
```

Update with production values:

```env
# Database Configuration
DATABASE_URL="postgresql://msguser:CHANGE_THIS_PASSWORD@localhost:5432/messaging?schema=public"

# JWT Configuration
JWT_SECRET="CHANGE_THIS_TO_A_SECURE_RANDOM_STRING_AT_LEAST_32_CHARACTERS_LONG"
JWT_EXPIRES_IN="15m"

# Server Configuration
PORT="3000"
NODE_ENV="production"
APP_ORIGIN="https://app.example.com"

# Sign-up
REGISTRATION_MODE="invite"

# Email (Resend; required in production)
RESEND_API_KEY="re_CHANGE_THIS"
EMAIL_FROM="Messenger <noreply@example.com>"
```

**Important**:
- Change `CHANGE_THIS_PASSWORD` to a strong, unique password
- Change `JWT_SECRET` to a long, random string (minimum 32 characters)

**To generate a secure JWT secret**, run:

```bash
openssl rand -base64 48
```

Save and exit (Ctrl+X, then Y, then Enter).

### 3. Update Frontend Environment Variables

```bash
cd client
nano .env.local
```

Update with production API URL:

```env
NEXT_PUBLIC_API_URL=http://YOUR_DROPLET_IP:3000
```

Or if using a domain name:

```env
NEXT_PUBLIC_API_URL=https://api.yourdomain.com
```

Save and exit.

### 4. Update docker-compose.yml

```bash
cd ~/prisma
nano docker-compose.yml
```

Make sure the PostgreSQL password matches your `.env` file:

```yaml
environment:
  POSTGRES_USER: msguser
  POSTGRES_PASSWORD: CHANGE_THIS_PASSWORD  # Must match .env
  POSTGRES_DB: messaging
```

---

## Start the Application

### 1. Install Node.js and pnpm on Server

```bash
# Install Node.js 22.x
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Install pnpm
sudo npm install -g pnpm

# Verify installation
node --version
pnpm --version
```

### 2. Start PostgreSQL Database

```bash
cd ~/prisma
docker compose up -d
```

Verify it's running:

```bash
docker compose ps
docker compose logs postgres
```

### 3. Install Backend Dependencies

```bash
pnpm install
```

### 4. Run Database Migrations

```bash
pnpm db:generate
pnpm db:migrate
```

### 5. Build and Start Backend API

```bash
# Start backend API (you may want to use PM2 for production - see below)
pnpm start
```

### 6. Install and Build Frontend (in another terminal)

Open a new SSH session:

```bash
ssh deploy@YOUR_DROPLET_IP
cd ~/prisma/client
pnpm install
pnpm build
```

### 7. Use PM2 for Process Management (Recommended)

Instead of running `pnpm start` directly, use PM2 to keep your applications running:

```bash
# Install PM2 globally
sudo npm install -g pm2

# Start backend API
cd ~/prisma
pm2 start pnpm --name "messaging-api" -- start

# Start frontend
cd ~/prisma/client
pm2 start pnpm --name "messaging-client" -- start

# Save PM2 configuration
pm2 save

# Set PM2 to start on system boot
pm2 startup

# View running processes
pm2 list

# View logs
pm2 logs messaging-api
pm2 logs messaging-client
```

---

## Configure Nginx

### 1. Create Nginx Configuration

```bash
sudo nano /etc/nginx/sites-available/messaging-app
```

### 2. Add Configuration

**If using domain name:**

```nginx
# API Server
server {
    listen 80;
    server_name api.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# Frontend Client
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**If using IP address only:**

```nginx
server {
    listen 80 default_server;
    server_name _;

    # Frontend on root
    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # API on /api path (Note: You'll need to update frontend .env.local)
    # Alternative: Access API directly on port 3000
}
```

### 3. Enable the Site

```bash
# Create symbolic link
sudo ln -s /etc/nginx/sites-available/messaging-app /etc/nginx/sites-enabled/

# Remove default site
sudo rm /etc/nginx/sites-enabled/default

# Test configuration
sudo nginx -t

# Restart Nginx
sudo systemctl restart nginx
```

### 4. Verify It's Working

Visit `http://YOUR_DROPLET_IP` or `http://yourdomain.com` in your browser.

---

## Set Up SSL (Optional but Recommended)

### Prerequisites

- A domain name pointing to your droplet's IP address
- DNS records configured:
  - A record: `yourdomain.com` → `YOUR_DROPLET_IP`
  - A record: `www.yourdomain.com` → `YOUR_DROPLET_IP`
  - A record: `api.yourdomain.com` → `YOUR_DROPLET_IP`

### 1. Install Certbot

```bash
sudo apt install -y certbot python3-certbot-nginx
```

### 2. Obtain SSL Certificate

```bash
# For all domains at once
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com -d api.yourdomain.com

# Follow the prompts:
# - Enter your email
# - Agree to terms
# - Choose whether to redirect HTTP to HTTPS (recommended: Yes)
```

### 3. Verify Auto-Renewal

```bash
# Test renewal process
sudo certbot renew --dry-run
```

Certbot will automatically renew certificates before they expire.

### 4. Update Frontend Environment Variable

```bash
cd ~/prisma/client
nano .env.local
```

Change to HTTPS:

```env
NEXT_PUBLIC_API_URL=https://api.yourdomain.com
```

Then rebuild and restart:

```bash
pnpm build
pm2 restart messaging-client
```

---

## Troubleshooting

### Check Application Logs

```bash
# PM2 logs
pm2 logs messaging-api
pm2 logs messaging-client

# Docker logs
docker compose logs postgres

# Nginx logs
sudo tail -f /var/log/nginx/error.log
sudo tail -f /var/log/nginx/access.log
```

### Application Won't Start

```bash
# Check if ports are in use
sudo netstat -tlnp | grep :3000
sudo netstat -tlnp | grep :3001

# Check PM2 status
pm2 list
pm2 describe messaging-api
pm2 describe messaging-client

# Restart applications
pm2 restart all
```

### Database Connection Issues

```bash
# Check if PostgreSQL container is running
docker compose ps

# Check PostgreSQL logs
docker compose logs postgres

# Test database connection
docker compose exec postgres psql -U msguser -d messaging

# If you need to reset the database
cd ~/prisma
docker compose down -v
docker compose up -d
pnpm db:migrate
```

### Nginx Issues

```bash
# Test Nginx configuration
sudo nginx -t

# Restart Nginx
sudo systemctl restart nginx

# Check Nginx status
sudo systemctl status nginx

# View error logs
sudo tail -f /var/log/nginx/error.log
```

### Permission Issues

```bash
# If you get permission errors with Docker
sudo usermod -aG docker $USER
# Then log out and back in

# If files have wrong ownership
sudo chown -R deploy:deploy ~/prisma
```

### Can't Access Application from Browser

1. **Check firewall**:
   ```bash
   sudo ufw status
   # Make sure ports 80 and 443 are allowed
   ```

2. **Check if services are running**:
   ```bash
   pm2 list
   docker compose ps
   sudo systemctl status nginx
   ```

3. **Check if ports are accessible**:
   ```bash
   # From your local machine
   curl http://YOUR_DROPLET_IP
   curl http://YOUR_DROPLET_IP:3000/health
   ```

### Frontend Can't Connect to API

1. **Check `.env.local`** in frontend - make sure API URL is correct
2. **Check CORS settings** in backend `src/server.ts`
3. **Check Nginx proxy configuration**
4. **Rebuild frontend** after changing environment variables:
   ```bash
   cd ~/prisma/client
   pnpm build
   pm2 restart messaging-client
   ```

---

## Maintenance Commands

### Update Application

```bash
# Pull latest changes (if using Git)
cd ~/prisma
git pull

# Backend
pnpm install
pnpm db:migrate
pm2 restart messaging-api

# Frontend
cd client
pnpm install
pnpm build
pm2 restart messaging-client
```

### Backup Database

```bash
# Create backup
docker compose exec postgres pg_dump -U msguser messaging > backup_$(date +%Y%m%d_%H%M%S).sql

# Restore from backup
docker compose exec -T postgres psql -U msguser messaging < backup_20260109_120000.sql
```

### Monitor Resources

```bash
# System resources
htop

# Docker resources
docker stats

# PM2 monitoring
pm2 monit
```

---

## Security Checklist

- [ ] Changed default PostgreSQL password in `docker-compose.yml` and `.env`
- [ ] Set strong JWT secret (minimum 32 characters)
- [ ] Configured firewall (UFW) to only allow necessary ports
- [ ] Using non-root user for deployment
- [ ] Set up SSL/HTTPS with Let's Encrypt
- [ ] Regular system updates: `sudo apt update && sudo apt upgrade`
- [ ] Database backups configured
- [ ] Consider setting up automated backups to Digital Ocean Spaces or S3

---

## Next Steps

1. **Set up automated backups** - Use cron jobs or Digital Ocean's backup feature
2. **Monitor application** - Set up monitoring with tools like Datadog, New Relic, or Prometheus
3. **Configure logging** - Centralize logs with services like Papertrail or Loggly
4. **Set up CI/CD** - Automate deployments with GitHub Actions or GitLab CI
5. **Add rate limiting** - Protect your API from abuse
6. **Configure CORS properly** - Restrict origins in production

---

**Your messaging application should now be live and accessible!** 🎉
