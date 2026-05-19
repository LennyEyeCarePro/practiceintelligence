#!/bin/bash
echo ""
echo "  Practice Intelligence — Local Server"
echo "  ====================================="
echo ""

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed. Download it from https://nodejs.org"
    exit 1
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
    echo ""
fi

# Check if public folder has files
if [ ! -f "public/seo-tool.html" ]; then
    echo "Setting up HTML files..."
    node setup-public.js
    echo ""
fi

# Check for .env file
if [ ! -f ".env" ]; then
    echo ""
    echo "WARNING: No .env file found!"
    echo "Copy .env.example to .env and add your API keys."
    echo ""
    exit 1
fi

# Start server and open browser
echo "Starting server..."
if [[ "$OSTYPE" == "darwin"* ]]; then
    open http://localhost:3000/seo-tool.html &
elif [[ "$OSTYPE" == "linux"* ]]; then
    xdg-open http://localhost:3000/seo-tool.html &
fi
node server.js
