# How to Use the Sprite VS Code Extension

## Installation

1. Copy the extension to your VS Code extensions directory:
   ```bash
   cp -r vscode-sprite-extension ~/.vscode/extensions/
   ```

2. Or package it as VSIX:
   ```bash
   npm install -g @vscode/vsce
   vsce package
   code --install-extension vscode-sprite-0.1.0.vsix
   ```

## Getting Your API Token

To get a Sprites.dev API token, you'll need to:

1. Visit [Sprites.dev](https://sprites.dev)
2. Sign in or create an account
3. Generate an API token from your account settings

## Configuration

1. Open VS Code
2. Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
3. Type `Sprite: Set API Token`
4. Enter your Sprites.dev API token

## Available Commands

### Sprite: List Sprites
Lists all your Sprites with their status. Click on a Sprite to view details.

### Sprite: Create Sprite
Creates a new Sprite with a name you specify.

### Sprite: Execute Command
Executes a command on a selected Sprite and displays the output in a new editor tab.

### Sprite: Open Terminal
Opens an interactive terminal session connected to a selected Sprite. You can run commands interactively just like a regular terminal.

### Sprite: Delete Sprite
Deletes a selected Sprite after confirmation.

## Features

- **List Management**: View all your Sprites in one place
- **Command Execution**: Run one-off commands and see the output
- **Interactive Terminal**: Full interactive terminal support with TTY
- **Easy Creation**: Create new Sprites with a single command
- **Safe Deletion**: Confirmation prompt before deleting Sprites

## Notes

- The extension requires Node.js 24.0.0 or later (warning can be ignored for development)
- All operations use the official `@fly/sprites` SDK
- API token is stored securely in VS Code settings
- Terminal sessions support full TTY features

## Troubleshooting

**Error: "Please set API token first"**
- Run `Sprite: Set API Token` command and enter your token

**Error: "No sprites found"**
- Create a sprite first using `Sprite: Create Sprite`

**Terminal not responding**
- Close and reopen the terminal using `Sprite: Open Terminal`
