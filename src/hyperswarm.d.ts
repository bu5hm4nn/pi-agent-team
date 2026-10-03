/**
 * hyperswarm 没有第一方 TypeScript 类型,也没有官方 @types 包。
 * 这里只声明本仓库实际用到的表面(见 AGENTS.md 的 hyperswarm 备注)。
 * 用到新 API 时在这里补,而不是拉一个来路不明的 @types 包。
 */
declare module "hyperswarm" {
  import { EventEmitter } from "node:events";
  import { Duplex } from "node:stream";

  interface PeerInfo {
    /** 对端 Noise 公钥 */
    publicKey: Buffer;
    topics: Buffer[];
    prioritized: boolean;
    /** 该连接是否由本端主动 dial(连接方向) */
    client?: boolean;
    ban(status?: boolean): void;
  }

  /**
   * hyperswarm 的 connection 事件给出的加密流(NoiseSecretStream)。
   * 只声明本仓库用到的部分:读写、以及 Noise 会话绑定。
   */
  interface NoiseSocket extends Duplex {
    /** 本端是否为 Noise 握手发起方,两侧互补 */
    isInitiator: boolean;
    /** 本次 Noise 会话的握手哈希,两侧相同;鉴权证明绑定它 */
    handshakeHash: Buffer | null;
    /** 对端 Noise 公钥 */
    remotePublicKey: Buffer | null;
  }

  interface KeyPair {
    publicKey: Buffer;
    secretKey: Buffer;
  }

  interface BootstrapNode {
    host: string;
    port: number;
  }

  interface HyperswarmOptions {
    /** 覆盖默认公共 bootstrap 节点 */
    bootstrap?: Array<BootstrapNode | string>;
    /** 直接注入一个 hyperdht 实例(测试用) */
    dht?: unknown;
    keyPair?: KeyPair;
    seed?: Buffer;
    maxPeers?: number;
    /** 返回 true 表示拒绝该连接 */
    firewall?: (remotePublicKey: Buffer, payload?: unknown) => boolean;
  }

  interface PeerDiscovery {
    flushed(): Promise<boolean>;
    refresh(opts?: { client?: boolean; server?: boolean }): Promise<void>;
    destroy(): Promise<void>;
  }

  class Hyperswarm extends EventEmitter {
    constructor(opts?: HyperswarmOptions);

    keyPair: KeyPair;
    dht: unknown;
    connecting: number;
    connections: Set<Duplex>;
    peers: Map<string, PeerInfo>;
    destroyed: boolean;
    listening: Promise<void> | null;

    join(topic: Buffer, opts?: { server?: boolean; client?: boolean; limit?: number }): PeerDiscovery;
    leave(topic: Buffer): Promise<void>;
    listen(): Promise<void>;
    flush(): Promise<void>;
    status(topic: Buffer): PeerDiscovery | null;
    suspend(opts?: { log?: (msg: string) => void }): Promise<void>;
    resume(opts?: { log?: (msg: string) => void }): Promise<void>;
    destroy(opts?: { force?: boolean }): Promise<void>;

    on(event: "connection", listener: (socket: NoiseSocket, peerInfo: PeerInfo) => void): this;
    on(event: "update", listener: () => void): this;
    on(event: "ban", listener: (peerInfo: PeerInfo, err: Error) => void): this;
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  }

  export = Hyperswarm;
}
