import * as vscode from 'vscode';

let SpritesClient: any;
let globalClient: any = null;
let spriteFs: any;

async function loadSDK() {
    if (!SpritesClient) {
        try {
            const sdk = await import('@fly/sprites');
            SpritesClient = sdk.SpritesClient;
            const { SpriteFileSystemProvider } = await import('./spriteFileSystem');
            spriteFs = new SpriteFileSystemProvider();
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to load Sprites SDK: ${error.message}`);
            throw error;
        }
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Sprite extension is now active');

    // Command: Set API Token
    const setToken = vscode.commands.registerCommand('sprite.setToken', async () => {
        const token = await vscode.window.showInputBox({
            prompt: 'Enter your Sprites.dev API token',
            password: true,
            ignoreFocusOut: true
        });

        if (token) {
            await context.secrets.store('spriteToken', token);
            try {
                await loadSDK();
                globalClient = new SpritesClient(token);
                spriteFs.setClient(globalClient);

                // Register filesystem provider if not already
                context.subscriptions.push(
                    vscode.workspace.registerFileSystemProvider('sprite', spriteFs, {
                        isCaseSensitive: true,
                        isReadonly: false
                    })
                );

                vscode.window.showInformationMessage('Sprite API token saved');
            } catch (error: any) {
                vscode.window.showErrorMessage(`Error: ${error.message}`);
            }
        }
    });

    // Command: Open Sprite (add as workspace folder)
    const openSprite = vscode.commands.registerCommand('sprite.openSprite', async () => {
        if (!globalClient) {
            const setNow = await vscode.window.showErrorMessage(
                'Please set API token first',
                'Set Token'
            );
            if (setNow === 'Set Token') {
                vscode.commands.executeCommand('sprite.setToken');
            }
            return;
        }

        try {
            const sprites = await globalClient.listAllSprites();

            if (sprites.length === 0) {
                const create = await vscode.window.showInformationMessage(
                    'No sprites found. Create one?',
                    'Create Sprite'
                );
                if (create === 'Create Sprite') {
                    vscode.commands.executeCommand('sprite.createSprite');
                }
                return;
            }

            const items: Array<{label: string; description: string; sprite: any}> = sprites.map((s: any) => ({
                label: s.name,
                description: s.status || '',
                sprite: s
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a Sprite to open'
            });

            if (!selected) {
                return;
            }

            const path = await vscode.window.showInputBox({
                prompt: 'Enter path to open',
                value: '/home/sprite',
                ignoreFocusOut: true
            });

            if (!path) {
                return;
            }

            const uri = vscode.Uri.parse(`sprite://${selected.sprite.name}${path}`);
            const workspaceFolders = vscode.workspace.workspaceFolders || [];
            vscode.workspace.updateWorkspaceFolders(
                workspaceFolders.length,
                0,
                { uri, name: `Sprite: ${selected.sprite.name}` }
            );

            vscode.window.showInformationMessage(`Opened Sprite: ${selected.sprite.name}`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error: ${error.message}`);
        }
    });

    // Command: Create Sprite
    const createSprite = vscode.commands.registerCommand('sprite.createSprite', async () => {
        if (!globalClient) {
            vscode.window.showErrorMessage('Please set API token first');
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
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Creating sprite: ${name}`,
                cancellable: false
            }, async () => {
                await globalClient.createSprite(name);
            });

            const open = await vscode.window.showInformationMessage(
                `Sprite '${name}' created successfully`,
                'Open Sprite'
            );

            if (open === 'Open Sprite') {
                const uri = vscode.Uri.parse(`sprite://${name}/home/sprite`);
                const workspaceFolders = vscode.workspace.workspaceFolders || [];
                vscode.workspace.updateWorkspaceFolders(
                    workspaceFolders.length,
                    0,
                    { uri, name: `Sprite: ${name}` }
                );
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error creating sprite: ${error.message}`);
        }
    });

    // Command: Open Terminal
    const openTerminal = vscode.commands.registerCommand('sprite.openTerminal', async () => {
        if (!globalClient) {
            vscode.window.showErrorMessage('Please set API token first');
            return;
        }

        let spriteName: string | undefined;

        const activeUri = vscode.window.activeTextEditor?.document.uri;
        if (activeUri?.scheme === 'sprite') {
            spriteName = activeUri.authority;
        }

        if (!spriteName) {
            const sprites = await globalClient.listAllSprites();
            if (sprites.length === 0) {
                vscode.window.showInformationMessage('No sprites found');
                return;
            }

            const items: Array<{label: string; sprite: any}> = sprites.map((s: any) => ({ label: s.name, sprite: s }));
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select sprite for terminal'
            });

            if (!selected) {
                return;
            }
            spriteName = selected.sprite.name;
        }

        const sprite = globalClient.sprite(spriteName);

        const writeEmitter = new vscode.EventEmitter<string>();
        let shellCmd: any;

        const pty: vscode.Pseudoterminal = {
            onDidWrite: writeEmitter.event,
            open: async (initialDimensions) => {
                writeEmitter.fire(`Connecting to sprite: ${spriteName}\r\n`);

                try {
                    shellCmd = sprite.spawn('bash', ['-l'], {
                        tty: true,
                        rows: initialDimensions?.rows || 24,
                        cols: initialDimensions?.columns || 80
                    });

                    shellCmd.stdout?.on('data', (data: Buffer) => {
                        writeEmitter.fire(data.toString());
                    });

                    shellCmd.stderr?.on('data', (data: Buffer) => {
                        writeEmitter.fire(data.toString());
                    });

                    shellCmd.on('exit', () => {
                        writeEmitter.fire('\r\n[Disconnected]\r\n');
                    });
                } catch (error: any) {
                    writeEmitter.fire(`\r\nError: ${error.message}\r\n`);
                }
            },
            close: () => {
                if (shellCmd) {
                    shellCmd.kill();
                }
            },
            handleInput: (data: string) => {
                if (shellCmd?.stdin) {
                    shellCmd.stdin.write(data);
                }
            },
            setDimensions: (dimensions: vscode.TerminalDimensions) => {
                if (shellCmd) {
                    shellCmd.resize(dimensions.columns, dimensions.rows);
                }
            }
        };

        const terminal = vscode.window.createTerminal({
            name: `Sprite: ${spriteName}`,
            pty
        });
        terminal.show();
    });

    // Command: Delete Sprite
    const deleteSprite = vscode.commands.registerCommand('sprite.deleteSprite', async () => {
        if (!globalClient) {
            vscode.window.showErrorMessage('Please set API token first');
            return;
        }

        try {
            const sprites = await globalClient.listAllSprites();
            if (sprites.length === 0) {
                vscode.window.showInformationMessage('No sprites found');
                return;
            }

            const items: Array<{label: string; sprite: any}> = sprites.map((s: any) => ({ label: s.name, sprite: s }));
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select sprite to delete'
            });

            if (!selected) {
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Delete sprite '${selected.sprite.name}'? This cannot be undone.`,
                { modal: true },
                'Delete'
            );

            if (confirm === 'Delete') {
                await globalClient.deleteSprite(selected.sprite.name);

                const workspaceFolders = vscode.workspace.workspaceFolders || [];
                const index = workspaceFolders.findIndex(
                    (f: vscode.WorkspaceFolder) => f.uri.scheme === 'sprite' && f.uri.authority === selected.sprite.name
                );
                if (index !== -1) {
                    vscode.workspace.updateWorkspaceFolders(index, 1);
                }

                vscode.window.showInformationMessage(`Sprite '${selected.sprite.name}' deleted`);
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error: ${error.message}`);
        }
    });

    // Command: Refresh
    const refreshSprite = vscode.commands.registerCommand('sprite.refresh', async () => {
        vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
    });

    context.subscriptions.push(
        setToken,
        openSprite,
        createSprite,
        openTerminal,
        deleteSprite,
        refreshSprite
    );

    // Try to restore token on startup
    context.secrets.get('spriteToken').then(async token => {
        if (token) {
            try {
                await loadSDK();
                globalClient = new SpritesClient(token);
                spriteFs.setClient(globalClient);
                context.subscriptions.push(
                    vscode.workspace.registerFileSystemProvider('sprite', spriteFs, {
                        isCaseSensitive: true,
                        isReadonly: false
                    })
                );
            } catch (e) {
                // SDK load failed, user will need to set token again
            }
        }
    });
}

export function deactivate() {}
