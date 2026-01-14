import * as vscode from 'vscode';
import { SpritesClient } from '@fly/sprites';

let globalClient: SpritesClient | null = null;

export function activate(context: vscode.ExtensionContext) {
    console.log('Sprite extension is now active');

    // Initialize client if token exists
    const config = vscode.workspace.getConfiguration('sprite');
    const token = config.get<string>('apiToken');
    if (token) {
        globalClient = new SpritesClient(token);
    }

    // Command: Set API Token
    const setToken = vscode.commands.registerCommand('sprite.setToken', async () => {
        const token = await vscode.window.showInputBox({
            prompt: 'Enter your Sprites.dev API token',
            password: true,
            ignoreFocusOut: true
        });

        if (token) {
            await config.update('apiToken', token, vscode.ConfigurationTarget.Global);
            globalClient = new SpritesClient(token);
            vscode.window.showInformationMessage('Sprite API token saved');
        }
    });

    // Command: List Sprites
    const listSprites = vscode.commands.registerCommand('sprite.listSprites', async () => {
        if (!globalClient) {
            vscode.window.showErrorMessage('Please set API token first (Sprite: Set API Token)');
            return;
        }

        try {
            vscode.window.showInformationMessage('Fetching sprites...');
            const sprites = await globalClient.listAllSprites();

            if (sprites.length === 0) {
                vscode.window.showInformationMessage('No sprites found');
                return;
            }

            const items = sprites.map(s => ({
                label: s.name,
                description: `Status: ${s.status || 'unknown'}`,
                sprite: s
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a sprite to view details'
            });

            if (selected) {
                vscode.window.showInformationMessage(
                    `Sprite: ${selected.sprite.name}\nStatus: ${selected.sprite.status || 'N/A'}`
                );
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error listing sprites: ${error.message}`);
        }
    });

    // Command: Create Sprite
    const createSprite = vscode.commands.registerCommand('sprite.createSprite', async () => {
        if (!globalClient) {
            vscode.window.showErrorMessage('Please set API token first (Sprite: Set API Token)');
            return;
        }

        const name = await vscode.window.showInputBox({
            prompt: 'Enter sprite name',
            placeHolder: 'my-sprite'
        });

        if (!name) {
            return;
        }

        try {
            vscode.window.showInformationMessage(`Creating sprite: ${name}...`);
            await globalClient.createSprite(name);
            vscode.window.showInformationMessage(`Sprite '${name}' created successfully`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error creating sprite: ${error.message}`);
        }
    });

    // Command: Execute Command
    const execCommand = vscode.commands.registerCommand('sprite.execCommand', async () => {
        if (!globalClient) {
            vscode.window.showErrorMessage('Please set API token first (Sprite: Set API Token)');
            return;
        }

        try {
            // Get list of sprites
            const sprites = await globalClient.listAllSprites();

            if (sprites.length === 0) {
                vscode.window.showInformationMessage('No sprites found. Create one first.');
                return;
            }

            // Select sprite
            const spriteItems = sprites.map(s => ({
                label: s.name,
                sprite: s
            }));

            const selectedSprite = await vscode.window.showQuickPick(spriteItems, {
                placeHolder: 'Select sprite to execute command on'
            });

            if (!selectedSprite) {
                return;
            }

            // Get command
            const command = await vscode.window.showInputBox({
                prompt: 'Enter command to execute',
                placeHolder: 'ls -la'
            });

            if (!command) {
                return;
            }

            // Execute command
            vscode.window.showInformationMessage(`Executing: ${command} on ${selectedSprite.label}...`);

            const sprite = globalClient.sprite(selectedSprite.sprite.name);
            const result = await sprite.exec(command);

            // Show output in new document
            const doc = await vscode.workspace.openTextDocument({
                content: `Command: ${command}\nSprite: ${selectedSprite.sprite.name}\n\n=== STDOUT ===\n${result.stdout}\n\n=== STDERR ===\n${result.stderr}`,
                language: 'plaintext'
            });
            await vscode.window.showTextDocument(doc);

        } catch (error: any) {
            vscode.window.showErrorMessage(`Error executing command: ${error.message}`);
        }
    });

    // Command: Delete Sprite
    const deleteSprite = vscode.commands.registerCommand('sprite.deleteSprite', async () => {
        if (!globalClient) {
            vscode.window.showErrorMessage('Please set API token first (Sprite: Set API Token)');
            return;
        }

        try {
            const sprites = await globalClient.listAllSprites();

            if (sprites.length === 0) {
                vscode.window.showInformationMessage('No sprites found');
                return;
            }

            const items = sprites.map(s => ({
                label: s.name,
                sprite: s
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select sprite to delete'
            });

            if (!selected) {
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Are you sure you want to delete sprite '${selected.sprite.name}'?`,
                'Yes', 'No'
            );

            if (confirm === 'Yes') {
                await globalClient.deleteSprite(selected.sprite.name);
                vscode.window.showInformationMessage(`Sprite '${selected.sprite.name}' deleted`);
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error deleting sprite: ${error.message}`);
        }
    });

    // Command: Open Terminal
    const openTerminal = vscode.commands.registerCommand('sprite.openTerminal', async () => {
        if (!globalClient) {
            vscode.window.showErrorMessage('Please set API token first (Sprite: Set API Token)');
            return;
        }

        try {
            const sprites = await globalClient.listAllSprites();

            if (sprites.length === 0) {
                vscode.window.showInformationMessage('No sprites found');
                return;
            }

            const items = sprites.map(s => ({
                label: s.name,
                sprite: s
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select sprite to open terminal'
            });

            if (!selected) {
                return;
            }

            const sprite = globalClient.sprite(selected.sprite.name);

            // Create pseudo-terminal
            const writeEmitter = new vscode.EventEmitter<string>();
            const pty: vscode.Pseudoterminal = {
                onDidWrite: writeEmitter.event,
                open: async () => {
                    writeEmitter.fire(`Connected to sprite: ${selected.sprite.name}\r\n\r\n`);

                    // Start interactive shell
                    const cmd = sprite.spawn('bash', [], { tty: true });

                    cmd.stdout?.on('data', (data) => {
                        writeEmitter.fire(data.toString());
                    });

                    cmd.stderr?.on('data', (data) => {
                        writeEmitter.fire(data.toString());
                    });

                    // Store command for input handling
                    (pty as any).cmd = cmd;
                },
                close: () => {
                    const cmd = (pty as any).cmd;
                    if (cmd) {
                        cmd.kill();
                    }
                },
                handleInput: (data: string) => {
                    const cmd = (pty as any).cmd;
                    if (cmd && cmd.stdin) {
                        cmd.stdin.write(data);
                    }
                }
            };

            const terminal = vscode.window.createTerminal({
                name: `Sprite: ${selected.sprite.name}`,
                pty
            });
            terminal.show();

        } catch (error: any) {
            vscode.window.showErrorMessage(`Error opening terminal: ${error.message}`);
        }
    });

    context.subscriptions.push(
        setToken,
        listSprites,
        createSprite,
        execCommand,
        deleteSprite,
        openTerminal
    );
}

export function deactivate() {}
