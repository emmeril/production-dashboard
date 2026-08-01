const ADMIN_OPERATOR_ROLES = ['admin_operator_sewing', 'admin_operator_qc'];
const PPIC_ROLE = 'ppic';
const DASHBOARD_VIEWER_ROLES = ['admin', ...ADMIN_OPERATOR_ROLES, PPIC_ROLE];
const LINE_MANAGER_ROLES = ['admin', 'admin_operator_sewing', PPIC_ROLE];
const REPORT_VIEWER_ROLES = [...DASHBOARD_VIEWER_ROLES];
const TARGET_ONLY_LINE_MANAGER_ROLES = ['admin_operator_sewing', PPIC_ROLE];

function normalizeRole(role) {
  return role === 'admin_operator' ? 'admin_operator_sewing' : role;
}

function hasAnyRole(user, allowedRoles) {
  const role = normalizeRole(user?.role);
  return Boolean(role && allowedRoles.includes(role));
}

module.exports = {
  ADMIN_OPERATOR_ROLES,
  DASHBOARD_VIEWER_ROLES,
  LINE_MANAGER_ROLES,
  PPIC_ROLE,
  REPORT_VIEWER_ROLES,
  TARGET_ONLY_LINE_MANAGER_ROLES,
  hasAnyRole,
  normalizeRole
};
