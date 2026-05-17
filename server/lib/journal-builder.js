const path             = require('path');
const { clipComparator } = require('./clip-sort');

// Takes classified clips and builds the assembly order
// (which b-roll goes under which narration)
async function buildJournal({ aroll, broll }) {
  const assembly = buildChronologicalAssembly(aroll, broll);
  return { assembly };
}

// Assemble in strict recording order using timestamps + filename numbers.
function buildChronologicalAssembly(aroll, broll) {
  const all = [
    ...aroll.map(c => ({ ...c, clipType: 'aroll' })),
    ...broll.map(c => ({ ...c, clipType: 'broll' })),
  ];
  all.sort(clipComparator);
  return all;
}

module.exports = { buildJournal };
