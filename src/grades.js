// Weighted class average per student: sum(weight × points/max) / sum(weight) over graded items.
// Homework items hold the FINAL score (after any late deduction), written when the feedback is returned.
const db = require('./db');
function averages(studentId) {
  return db.prepare(`SELECT sec.id section_id, c.code, c.title, c.title_az, e.final_grade,
      ROUND(100.0 * SUM(COALESCE(gi.weight,1) * g.points / gi.max_points) / NULLIF(SUM(CASE WHEN g.id IS NOT NULL THEN COALESCE(gi.weight,1) END),0), 1) pct,
      COUNT(g.id) n
    FROM enrollments e JOIN sections sec ON sec.id=e.section_id JOIN courses c ON c.id=sec.course_id
    LEFT JOIN grade_items gi ON gi.section_id=sec.id AND gi.max_points > 0
    LEFT JOIN grades g ON g.grade_item_id=gi.id AND g.student_id=e.student_id AND g.points IS NOT NULL
    WHERE e.student_id=? GROUP BY sec.id ORDER BY c.code`).all(studentId)
    .map(r => ({ ...r, pct: r.n ? r.pct : null }));
}
function sectionAverages(sectionId) {
  return db.prepare(`SELECT s.id, s.name, e.id enrollment_id, e.final_grade,
      ROUND(100.0 * SUM(COALESCE(gi.weight,1) * g.points / gi.max_points) / NULLIF(SUM(CASE WHEN g.id IS NOT NULL THEN COALESCE(gi.weight,1) END),0), 1) pct
    FROM enrollments e JOIN students s ON s.id=e.student_id
    LEFT JOIN grade_items gi ON gi.section_id=e.section_id AND gi.max_points > 0
    LEFT JOIN grades g ON g.grade_item_id=gi.id AND g.student_id=s.id AND g.points IS NOT NULL
    WHERE e.section_id=? GROUP BY e.id ORDER BY s.name`).all(sectionId);
}
module.exports = { averages, sectionAverages };
