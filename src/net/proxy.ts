/**
 * 出站代理支持：http、https、socks5、socks5h。
 * 全部零依赖自己实现——SOCKS5 握手只有几十行，不值得为它引一个包。
 *
 * 实现拆在 net/proxy/ 下（spec 解析 / socks5 握手 / connect 建连），
 * 这里只做转出。拆分原因：单文件曾达 376 行。
 */

export * from "./proxy/spec.ts";
export * from "./proxy/socks5.ts";
export * from "./proxy/connect.ts";
