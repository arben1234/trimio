function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[àáâãäå]/g, 'a')
    .replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i')
    .replace(/[òóôõö]/g, 'o')
    .replace(/[ùúûü]/g, 'u')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-');
}

function uniqueSlug(name, existingSlugs) {
  let base = slugify(name);
  if (!base) base = 'salon';
  let slug = base;
  let i = 2;
  while (existingSlugs.includes(slug)) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

module.exports = { slugify, uniqueSlug };
