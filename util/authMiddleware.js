const { extractToken, verifyToken } = require('./authToken');

const PUBLIC_PATH_PREFIX = ['/login'];

function isPublicPath(pathname) {
  return PUBLIC_PATH_PREFIX.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

module.exports = async function authMiddleware(req, res, next) {
  try {
    if (req.method === 'OPTIONS' || isPublicPath(req.path)) {
      return next();
    }

    const token = extractToken(req);
    if (!token) {
      return res.status(401).send({
        status: 401,
        code: 'TOKEN_REQUIRED',
        message: '登录已失效，请先登录。',
      });
    }

    const check = await verifyToken(token);
    if (!check.ok) {
      return res.status(401).send({
        status: 401,
        code: check.code,
        message: check.message,
      });
    }

    req.auth = {
      account: check.account,
      tokenExpireAt: check.expireAt,
    };
    next();
  } catch (err) {
    console.error('[auth] verify failed:', err);
    return res.status(500).send({
      status: 500,
      code: 'AUTH_VERIFY_ERROR',
      message: '鉴权失败，请稍后重试。',
    });
  }
};
