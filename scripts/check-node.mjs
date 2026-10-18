// Runs before npm scripts. Plain JavaScript on purpose: it must work on Node versions that cannot run
// the TypeScript sources, so it can explain the problem instead of failing with ERR_UNKNOWN_FILE_EXTENSION.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 23 || (major === 23 && minor < 6)) {
  process.stderr.write([
    `Continuity Board는 Node.js 23.6 이상이 필요합니다 (지금: v${process.versions.node}).`,
    'TypeScript 파일을 빌드 없이 바로 실행하기 때문입니다.',
    '  nvm을 쓰면:  nvm install && nvm use   (.nvmrc에 24가 지정되어 있습니다)',
    '  그 외:       https://nodejs.org 에서 Node.js 24 LTS를 설치하세요',
    '',
  ].join('\n'));
  process.exit(1);
}
