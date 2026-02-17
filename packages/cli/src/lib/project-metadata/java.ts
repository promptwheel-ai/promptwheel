/**
 * Java / Kotlin detector
 */

import type { DetectorContext, ProjectMetadata } from './types.js';

export function detectJava(ctx: DetectorContext, meta: ProjectMetadata): void {
  if (ctx.exists('pom.xml')) {
    if (!meta.languages.includes('Java')) meta.languages.push('Java');
    meta.package_manager = meta.package_manager ?? 'maven';
    if (!meta.test_runner) {
      meta.test_runner = {
        name: 'junit',
        run_command: 'mvn test',
        filter_syntax: 'mvn test -Dtest=<ClassName>#<methodName>',
      };
    }
    const pom = ctx.readText('pom.xml') ?? '';
    if (pom.includes('spring-boot')) { meta.framework = meta.framework ?? 'Spring Boot'; }
    meta.signals.push('pom.xml detected');
  } else if (ctx.exists('build.gradle') || ctx.exists('build.gradle.kts')) {
    const lang = ctx.exists('build.gradle.kts') ? 'Kotlin' : 'Java';
    if (!meta.languages.includes(lang)) meta.languages.push(lang);
    meta.package_manager = meta.package_manager ?? 'gradle';
    if (!meta.test_runner) {
      meta.test_runner = {
        name: 'junit',
        run_command: './gradlew test',
        filter_syntax: './gradlew test --tests <ClassName>',
      };
    }
    meta.signals.push('build.gradle detected');
  }
}
