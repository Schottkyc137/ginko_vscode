import { workspace, ExtensionContext, window } from 'vscode';
import * as os from 'os';
import * as fs from 'fs-extra';
import semver = require('semver')
import path = require('path')
import { Octokit } from 'octokit';
import extract = require('extract-zip')
import { finished } from 'stream/promises';
const output = window.createOutputChannel('Ginko Client');
import util = require('util')
// eslint-disable-next-line @typescript-eslint/no-var-requires
// const exec = util.promisify(require('child_process').exec);
import { exec } from 'child_process';

import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
} from 'vscode-languageclient/node';
import { Readable } from 'stream';

let client: LanguageClient;
const languageServerBinaryName = 'ginko_ls';
let languageServerExecutable: string;

enum Platform {
    X86_64_LINUX,
    X86_64_WINDOWS,
    AARCH64_APPLE,
    UNSUPPORTED,
}

function getPlatform(): Platform {
    const arch = os.arch();
    const platform = os.platform();
    if (arch === 'x64' && platform === 'linux') {
        return Platform.X86_64_LINUX;
    } else if (arch === 'x64' && platform === 'win32') {
        return Platform.X86_64_WINDOWS;
    } else if (arch === 'arm64' && platform === 'darwin') {
        return Platform.AARCH64_APPLE;
    } else {
        return Platform.UNSUPPORTED;
    }
}

function getLanguageServerName(): string {
    switch (getPlatform()) {
        case Platform.X86_64_LINUX:
            return 'ginko_ls-x86_64-unknown-linux-gnu';
        case Platform.X86_64_WINDOWS:
            return 'ginko_ls-x86_64-pc-windows-msvc';
        case Platform.AARCH64_APPLE:
            return 'ginko_ls-aarch64-apple-darwin';
        default:
            throw new Error(
                `Unsupported Platform ${os.arch()}-${os.platform()}. Only x86_64 linux, x86_64 windows and Apple Silicon are supported.`
            );
    }
}

function getLanguageServerExtension(): string {
    switch (getPlatform()) {
        case Platform.X86_64_WINDOWS:
            return '.exe';
        default:
            return '';
    }
}

async function getLanguageServerVersion(executable: string): Promise<string> {
    const { stdout } = await util.promisify(exec)(`"${executable}" --version`);
    return semver.valid(semver.coerce(stdout.split(' ', 2)[1]));
}

type LanguageServerBinary = 'embedded' | 'systemPath'

export async function activate(ctx: ExtensionContext) {
    const languageServerBinary = workspace
        .getConfiguration()
        .get('ginko.languageServer');
    const lsBinary = languageServerBinary as LanguageServerBinary;

    let languageServerCommand: string;

    switch (lsBinary) {
        case 'embedded':
            {
                const languageServerDir = ctx.asAbsolutePath(
                    path.join('server', languageServerBinaryName)
                );
                output.appendLine(
                    'Checking for language server executable in ' +
                        languageServerDir
                );

                languageServerExecutable = ctx.asAbsolutePath(
                    path.join(
                        'server',
                        languageServerBinaryName,
                        getLanguageServerName(),
                        'bin',
                        languageServerBinaryName + getLanguageServerExtension()
                    )
                );

                await getLatestLanguageServer(60000, ctx);
                languageServerCommand = languageServerExecutable;
            }
            break;
        case 'systemPath':
            {
                const version = await getLanguageServerVersion(
                    languageServerBinaryName
                );
                output.appendLine(
                    `Using ginko_ls version ${version} from the system path`
                );
                languageServerCommand = languageServerBinaryName;
            }

            break;
    }

    const serverOptions: ServerOptions = {
        run: { command: languageServerCommand },
        debug: { command: languageServerCommand },
    };

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
        // Register the server for plain text documents
        documentSelector: [{ scheme: 'file', language: 'dts' }],
        synchronize: {
            // Notify the server about file changes to '.clientrc files contained in the workspace
            fileEvents: workspace.createFileSystemWatcher('**/.clientrc'),
        },
    };

    // Create the language client and start the client.
    client = new LanguageClient(
        'ginko_ls',
        'Ginko LS',
        serverOptions,
        clientOptions
    );

    // Start the client. This will also launch the server
    client.start();
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}

const ginko = {
    owner: 'Schottkyc137',
    repo: 'ginko',
};

async function getLatestLanguageServer(
    timeoutMs: number,
    ctx: ExtensionContext
) {
    // Get current and latest version
    const octokit = new Octokit();
    const latestRelease = await octokit.rest.repos.getLatestRelease({
        owner: ginko.owner,
        repo: ginko.repo,
    });
    if (latestRelease.status != 200) {
        throw new Error('Status 200 return when getting latest release');
    }
    let current: string;
    output.appendLine(
        `Using language server executable at ${languageServerExecutable}`
    );
    if (await fs.exists(languageServerExecutable)) {
        current = await getLanguageServerVersion(languageServerExecutable);
        output.appendLine(`Current ginko_ls version: ${current}`);
    } else {
        current = '0.0.0';
        output.appendLine('No language server installed');
    }

    const latest = semver.valid(semver.coerce(latestRelease.data.name));
    output.appendLine(`Latest ginko_ls version: ${latest}`);

    // Download new version if available
    if (semver.prerelease(latest)) {
        output.appendLine('Latest version is pre-release, skipping');
    } else if (semver.lte(latest, current)) {
        output.appendLine('Language server is up-to-date');
    } else {
        window.showInformationMessage('Downloading language server...');
        const languageServerName = getLanguageServerName();
        const languageServerAssetName = languageServerName + '.zip';
        const browser_download_url = latestRelease.data.assets.filter(
            (asset) => asset.name == languageServerAssetName
        )[0].browser_download_url;
        // TODO: This does not work ATM; need to create binary assets first.
        if (browser_download_url.length == 0) {
            throw new Error(
                `No asset with name ${languageServerAssetName} in release.`
            );
        }

        output.appendLine('Fetching ' + browser_download_url);
        const abortController = new AbortController();
        setTimeout(() => {
            abortController.abort();
        }, timeoutMs);
        const download = await fetch(browser_download_url, {
            signal: abortController.signal,
        }).catch((err) => {
            output.appendLine(err);
            throw new Error(
                `Language server download timed out after ${timeoutMs.toFixed(
                    2
                )} seconds.`
            );
        });
        if (download.status != 200) {
            throw new Error('Download returned status != 200');
        }
        const languageServerAsset = ctx.asAbsolutePath(
            path.join('server', 'install', latest, languageServerAssetName)
        );
        output.appendLine(`Writing ${languageServerAsset}`);
        if (!fs.existsSync(path.dirname(languageServerAsset))) {
            fs.mkdirSync(path.dirname(languageServerAsset), {
                recursive: true,
            });
        }

        const fileStream = fs.createWriteStream(languageServerAsset, {
            flags: 'wx',
        });
        await finished(Readable.fromWeb(download.body).pipe(fileStream));

        await new Promise<void>((resolve, reject) => {
            const targetDir = ctx.asAbsolutePath(
                path.join('server', 'ginko_ls')
            );
            output.appendLine(
                `Extracting ${languageServerAsset} to ${targetDir}`
            );
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }
            extract(languageServerAsset, { dir: targetDir })
                .then(() => {
                    output.appendLine(`Server extracted to ${targetDir}`);
                    resolve();
                })
                .catch((err) => {
                    output.appendLine('Error when extracting server');
                    output.appendLine(err);
                    try {
                        fs.removeSync(targetDir);
                    } catch (err) {
                        output.appendLine(`Cannot remove ${targetDir}: ${err}`);
                    }
                    reject(err);
                })
                .finally(() => {
                    try {
                        fs.removeSync(
                            ctx.asAbsolutePath(path.join('server', 'install'))
                        );
                    } catch (err) {
                        output.appendLine(
                            `Cannot remove ${ctx.asAbsolutePath(
                                path.join('server', 'install')
                            )}: ${err}`
                        );
                    }
                });
        });
    }
    return Promise.resolve();
}
