/** Config de Jest para el API (ts-jest sobre el tsconfig del repo). */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  testTimeout: 15000,
};
