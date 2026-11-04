// 入口：静态网页由 Cloudflare 直接返回；接口、MCP、参赛说明交给唯一的 Arena 实例处理
export { Arena } from './arena.js';

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith('/api/') || pathname === '/mcp' || pathname === '/agent.md' || pathname === '/llms.txt') {
      if (!env.ARENA) {
        // 分支预览没有绑定比赛数据（见 wrangler.jsonc 的 previews）
        return Response.json({ ok: false, error: '这是分支预览版，不连接比赛数据。请用正式网址。' }, { status: 503 });
      }
      const arena = env.ARENA.get(env.ARENA.idFromName('main'));
      return arena.fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};
