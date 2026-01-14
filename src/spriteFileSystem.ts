import * as vscode from 'vscode';
import { SpritesClient, Sprite } from '@fly/sprites';

function toStr(value: string | Buffer): string {
    return typeof value === 'string' ? value : value.toString('utf8');
}

export class SpriteFileSystemProvider implements vscode.FileSystemProvider {
    private client: SpritesClient | null = null;
    private spriteCache: Map<string, Sprite> = new Map();
    private clientReadyPromise: Promise<void> | null = null;
    private clientReadyResolve: (() => void) | null = null;

    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    constructor() {
        // Create a promise that resolves when client is set
        this.clientReadyPromise = new Promise((resolve) => {
            this.clientReadyResolve = resolve;
        });
    }

    setClient(client: SpritesClient) {
        this.client = client;
        this.spriteCache.clear();
        // Signal that client is ready
        if (this.clientReadyResolve) {
            this.clientReadyResolve();
            this.clientReadyResolve = null;
        }
    }

    // Wait for client to be ready (with timeout)
    private async waitForClient(timeoutMs: number = 5000): Promise<boolean> {
        if (this.client) return true;
        if (!this.clientReadyPromise) return false;

        const timeout = new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), timeoutMs)
        );
        const ready = this.clientReadyPromise.then(() => true);

        return Promise.race([ready, timeout]);
    }

    private getSprite(spriteName: string): Sprite | null {
        if (!this.client) {
            return null;
        }

        let sprite = this.spriteCache.get(spriteName);
        if (!sprite) {
            sprite = this.client.sprite(spriteName);
            this.spriteCache.set(spriteName, sprite);
        }
        return sprite;
    }

    private parseUri(uri: vscode.Uri): { spriteName: string; path: string } {
        const spriteName = uri.authority;
        const path = uri.path || '/';
        return { spriteName, path };
    }

    // Execute command, return result even if exit code is non-zero
    private async safeExec(sprite: Sprite, command: string): Promise<{stdout: string; stderr: string; exitCode: number}> {
        try {
            console.log(`Sprite safeExec: running "${command.substring(0, 50)}..."`);
            const result = await sprite.exec(command);
            console.log(`Sprite safeExec: success`);
            return {
                stdout: toStr(result.stdout),
                stderr: toStr(result.stderr),
                exitCode: 0
            };
        } catch (error: any) {
            console.log(`Sprite safeExec: error - ${error.message}`);
            // Check if error has stdout/stderr (exec failed but returned output)
            if (error.stdout !== undefined || error.stderr !== undefined) {
                return {
                    stdout: error.stdout ? toStr(error.stdout) : '',
                    stderr: error.stderr ? toStr(error.stderr) : '',
                    exitCode: error.exitCode || 1
                };
            }
            // Re-throw if it's a connection/websocket error
            throw error;
        }
    }

    watch(_uri: vscode.Uri): vscode.Disposable {
        return new vscode.Disposable(() => {});
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        console.log(`Sprite stat: uri="${uri.toString()}", authority="${uri.authority}", path="${uri.path}"`);
        const { spriteName, path } = this.parseUri(uri);

        // Wait for client to be ready before giving up
        if (!this.client) {
            await this.waitForClient();
        }

        const sprite = this.getSprite(spriteName);

        if (!sprite) {
            // Not connected - token not set
            console.log(`Sprite stat: no sprite found for "${spriteName}"`);
            throw vscode.FileSystemError.FileNotFound(uri);
        }

        try {
            // Use test + stat to avoid errors on missing files
            console.log(`Sprite stat: executing command for "${path}"`);
            const result = await this.safeExec(sprite,
                `if [ -e "${path}" ]; then stat -c '%F|%s|%Y|%X' "${path}"; else echo "NOTFOUND"; fi`
            );
            console.log(`Sprite stat: result for "${path}" - stdout="${result.stdout.trim()}", exitCode=${result.exitCode}`);
            const output = result.stdout.trim();

            if (output === 'NOTFOUND' || !output) {
                throw vscode.FileSystemError.FileNotFound(uri);
            }

            const [typeStr, sizeStr, mtimeStr, ctimeStr] = output.split('|');
            const size = parseInt(sizeStr, 10) || 0;
            const mtime = parseInt(mtimeStr, 10) * 1000 || Date.now();
            const ctime = parseInt(ctimeStr, 10) * 1000 || Date.now();

            let type = vscode.FileType.Unknown;
            if (typeStr.includes('directory')) {
                type = vscode.FileType.Directory;
            } else if (typeStr.includes('regular') || typeStr.includes('file')) {
                type = vscode.FileType.File;
            } else if (typeStr.includes('symbolic link')) {
                type = vscode.FileType.SymbolicLink;
            }

            return { type, ctime, mtime, size };
        } catch (error: any) {
            console.log(`Sprite stat: caught error for "${path}" - ${error.message}`);
            if (error instanceof vscode.FileSystemError) {
                throw error;
            }
            console.error(`stat failed for ${uri.toString()}:`, error);
            throw vscode.FileSystemError.Unavailable(`Failed to stat ${path}: ${error.message}`);
        }
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const { spriteName, path } = this.parseUri(uri);

        if (!this.client) {
            await this.waitForClient();
        }

        const sprite = this.getSprite(spriteName);

        if (!sprite) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }

        try {
            const result = await this.safeExec(sprite, `ls -1Ap "${path}" 2>/dev/null || true`);
            const output = result.stdout.trim();

            if (!output) {
                return [];
            }

            const entries: [string, vscode.FileType][] = [];
            for (const line of output.split('\n')) {
                if (!line) continue;

                let name = line;
                let type = vscode.FileType.File;

                if (name.endsWith('/')) {
                    name = name.slice(0, -1);
                    type = vscode.FileType.Directory;
                } else if (name.endsWith('@')) {
                    name = name.slice(0, -1);
                    type = vscode.FileType.SymbolicLink;
                } else if (name.endsWith('*')) {
                    name = name.slice(0, -1);
                    type = vscode.FileType.File;
                } else if (name.endsWith('|') || name.endsWith('=')) {
                    name = name.slice(0, -1);
                    type = vscode.FileType.File;
                }

                if (name && name !== '.' && name !== '..') {
                    entries.push([name, type]);
                }
            }

            return entries;
        } catch (error: any) {
            console.error(`readDirectory failed for ${uri.toString()}:`, error);
            throw vscode.FileSystemError.Unavailable(`Failed to list ${path}: ${error.message}`);
        }
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const { spriteName, path } = this.parseUri(uri);

        if (!this.client) {
            await this.waitForClient();
        }

        const sprite = this.getSprite(spriteName);

        if (!sprite) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }

        try {
            // First check if file exists
            const checkResult = await this.safeExec(sprite, `test -f "${path}" && echo EXISTS || echo NOTFOUND`);
            if (checkResult.stdout.trim() !== 'EXISTS') {
                throw vscode.FileSystemError.FileNotFound(uri);
            }

            // Read file content
            const result = await this.safeExec(sprite, `base64 "${path}"`);
            const base64Content = result.stdout.replace(/\s/g, '');

            if (!base64Content) {
                // Empty file
                return new Uint8Array(0);
            }

            const binaryString = atob(base64Content);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            return bytes;
        } catch (error: any) {
            if (error instanceof vscode.FileSystemError) {
                throw error;
            }
            console.error(`readFile failed for ${uri.toString()}:`, error);
            throw vscode.FileSystemError.Unavailable(`Failed to read ${path}: ${error.message}`);
        }
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
        const { spriteName, path } = this.parseUri(uri);
        const sprite = this.getSprite(spriteName);

        if (!sprite) {
            throw vscode.FileSystemError.Unavailable('Not connected to Sprites API');
        }

        try {
            const existsResult = await this.safeExec(sprite, `test -e "${path}" && echo EXISTS || echo NOTEXISTS`);
            const exists = existsResult.stdout.trim() === 'EXISTS';

            if (exists && !options.overwrite) {
                throw vscode.FileSystemError.FileExists(uri);
            }
            if (!exists && !options.create) {
                throw vscode.FileSystemError.FileNotFound(uri);
            }

            const parentDir = path.substring(0, path.lastIndexOf('/')) || '/';
            await this.safeExec(sprite, `mkdir -p "${parentDir}"`);

            const base64Content = Buffer.from(content).toString('base64');
            await this.safeExec(sprite, `echo "${base64Content}" | base64 -d > "${path}"`);

            this._emitter.fire([{
                type: exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created,
                uri
            }]);
        } catch (error: any) {
            if (error instanceof vscode.FileSystemError) {
                throw error;
            }
            console.error(`writeFile failed for ${uri.toString()}:`, error);
            throw vscode.FileSystemError.Unavailable(`Failed to write ${path}: ${error.message}`);
        }
    }

    async createDirectory(uri: vscode.Uri): Promise<void> {
        const { spriteName, path } = this.parseUri(uri);
        const sprite = this.getSprite(spriteName);

        if (!sprite) {
            throw vscode.FileSystemError.Unavailable('Not connected to Sprites API');
        }

        try {
            const result = await this.safeExec(sprite, `mkdir -p "${path}"`);
            if (result.exitCode !== 0) {
                throw new Error(result.stderr || 'mkdir failed');
            }

            this._emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
        } catch (error: any) {
            console.error(`createDirectory failed for ${uri.toString()}:`, error);
            throw vscode.FileSystemError.Unavailable(`Failed to create ${path}: ${error.message}`);
        }
    }

    async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
        const { spriteName, path } = this.parseUri(uri);
        const sprite = this.getSprite(spriteName);

        if (!sprite) {
            throw vscode.FileSystemError.Unavailable('Not connected to Sprites API');
        }

        try {
            const flags = options.recursive ? '-rf' : '-f';
            await this.safeExec(sprite, `rm ${flags} "${path}"`);

            this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
        } catch (error: any) {
            console.error(`delete failed for ${uri.toString()}:`, error);
            throw vscode.FileSystemError.Unavailable(`Failed to delete ${path}: ${error.message}`);
        }
    }

    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
        const { spriteName: oldSprite, path: oldPath } = this.parseUri(oldUri);
        const { spriteName: newSprite, path: newPath } = this.parseUri(newUri);

        if (oldSprite !== newSprite) {
            throw vscode.FileSystemError.NoPermissions('Cannot move files between different Sprites');
        }

        const sprite = this.getSprite(oldSprite);

        if (!sprite) {
            throw vscode.FileSystemError.Unavailable('Not connected to Sprites API');
        }

        try {
            if (!options.overwrite) {
                const existsResult = await this.safeExec(sprite, `test -e "${newPath}" && echo EXISTS || echo NOTEXISTS`);
                if (existsResult.stdout.trim() === 'EXISTS') {
                    throw vscode.FileSystemError.FileExists(newUri);
                }
            }

            await this.safeExec(sprite, `mv "${oldPath}" "${newPath}"`);

            this._emitter.fire([
                { type: vscode.FileChangeType.Deleted, uri: oldUri },
                { type: vscode.FileChangeType.Created, uri: newUri }
            ]);
        } catch (error: any) {
            if (error instanceof vscode.FileSystemError) {
                throw error;
            }
            console.error(`rename failed:`, error);
            throw vscode.FileSystemError.Unavailable(`Failed to rename: ${error.message}`);
        }
    }
}
