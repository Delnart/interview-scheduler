const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Не авторизовано' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, email, isAdmin }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Недійсний або просрочений токен' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Потрібні права адміністратора' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
