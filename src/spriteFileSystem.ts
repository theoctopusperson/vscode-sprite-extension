import * as vscode from 'vscode';
import { SpritesClient, Sprite } from '@fly/sprites';

function toStr(value: string | Buffer): string {
    return typeof value === 'string' ? value : value.toString('utf8');
}

export class SpriteFileSystemProvider implements vscode.FileSystemProvider {
    private client: SpritesClient | null = null;
    private spriteCache: Map<string, Sprite> = new Map();

    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    setClient(client: SpritesClient) {
        this.client = client;
        this.spriteCache.clear();
    }

    private getSprite(spriteName: string): Sprite {
        if (!this.client) {
            throw vscode.FileSystemError.Unavailable('Not connected to Sprites API');
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

    private async execWithRetry(sprite: Sprite, command: string, retries = 2): Promise<{stdout: string; stderr: string}> {
        let lastError: any;
        for (let i = 0; i <= retries; i++) {
            try {
                const result = await sprite.exec(command);
                return {
                    stdout: toStr(result.stdout),
                    stderr: toStr(result.stderr)
                };
            } catch (error: any) {
                lastError = error;
                console.error(`Sprite exec attempt ${i + 1} failed:`, error.message);
                if (i < retries) {
                    // Wait a bit before retrying
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
        }
        throw lastError;
    }

    watch(_uri: vscode.Uri): vscode.Disposable {
        return new vscode.Disposable(() => {});
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const { spriteName, path } = this.parseUri(uri);
        const sprite = this.getSprite(spriteName);

        try {
            const result = await this.execWithRetry(sprite, `stat -c '%F|%s|%Y|%X' "${path}" 2>/dev/null || echo "NOTFOUND"`);
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
            if (error instanceof vscode.FileSystemError) {
                throw error;
            }
            console.error(`stat failed for ${uri.toString()}:`, error);
            throw vscode.FileSystemError.Unavailable(`Failed to stat ${path}: ${error.message}`);
        }
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const { spriteName, path } = this.parseUri(uri);
        const sprite = this.getSprite(spriteName);

        try {
            const result = await this.execWithRetry(sprite, `ls -1Ap "${path}" 2>/dev/null`);
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
        const sprite = this.getSprite(spriteName);

        try {
            const result = await this.execWithRetry(sprite, `base64 "${path}" 2>/dev/null`);
            const base64Content = result.stdout.replace(/\s/g, '');

            if (!base64Content) {
                const checkResult = await this.execWithRetry(sprite, `test -f "${path}" && echo EXISTS`);
                if (checkResult.stdout.trim() === 'EXISTS') {
                    return new Uint8Array(0);
                }
                throw vscode.FileSystemError.FileNotFound(uri);
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

        try {
            const existsResult = await this.execWithRetry(sprite, `test -e "${path}" && echo EXISTS || echo NOTEXISTS`);
            const exists = existsResult.stdout.trim() === 'EXISTS';

            if (exists && !options.overwrite) {
                throw vscode.FileSystemError.FileExists(uri);
            }
            if (!exists && !options.create) {
                throw vscode.FileSystemError.FileNotFound(uri);
            }

            const parentDir = path.substring(0, path.lastIndexOf('/')) || '/';
            await this.execWithRetry(sprite, `mkdir -p "${parentDir}"`);

            const base64Content = Buffer.from(content).toString('base64');
            await this.execWithRetry(sprite, `echo "${base64Content}" | base64 -d > "${path}"`);

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

        try {
            const result = await this.execWithRetry(sprite, `mkdir -p "${path}"`);
            if (result.stderr && result.stderr.includes('error')) {
                throw new Error(result.stderr);
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

        try {
            const flags = options.recursive ? '-rf' : '-f';
            await this.execWithRetry(sprite, `rm ${flags} "${path}"`);

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

        try {
            if (!options.overwrite) {
                const existsResult = await this.execWithRetry(sprite, `test -e "${newPath}" && echo EXISTS`);
                if (existsResult.stdout.trim() === 'EXISTS') {
                    throw vscode.FileSystemError.FileExists(newUri);
                }
            }

            await this.execWithRetry(sprite, `mv "${oldPath}" "${newPath}"`);

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
