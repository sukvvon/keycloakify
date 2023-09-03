import { transformCodebase } from "../../tools/transformCodebase";
import * as fs from "fs";
import { join as pathJoin } from "path";
import { replaceImportsFromStaticInJsCode } from "../replacers/replaceImportsFromStaticInJsCode";
import { replaceImportsInCssCode } from "../replacers/replaceImportsInCssCode";
import { generateFtlFilesCodeFactory, loginThemePageIds, accountThemePageIds } from "../generateFtl";
import { themeTypes, type ThemeType, lastKeycloakVersionWithAccountV1, keycloak_resources } from "../../constants";
import { isInside } from "../../tools/isInside";
import type { BuildOptions } from "../BuildOptions";
import { assert, type Equals } from "tsafe/assert";
import { downloadKeycloakStaticResources } from "./downloadKeycloakStaticResources";
import { readFieldNameUsage } from "./readFieldNameUsage";
import { readExtraPagesNames } from "./readExtraPageNames";
import { generateMessageProperties } from "./generateMessageProperties";
import { readStaticResourcesUsage } from "./readStaticResourcesUsage";

export type BuildOptionsLike = {
    themeName: string;
    extraThemeProperties: string[] | undefined;
    themeVersion: string;
    loginThemeDefaultResourcesFromKeycloakVersion: string;
    urlPathname: string | undefined;
};

assert<BuildOptions extends BuildOptionsLike ? true : false>();

export async function generateTheme(params: {
    projectDirPath: string;
    reactAppBuildDirPath: string;
    keycloakThemeBuildingDirPath: string;
    themeSrcDirPath: string;
    keycloakifySrcDirPath: string;
    buildOptions: BuildOptionsLike;
    keycloakifyVersion: string;
}): Promise<void> {
    const {
        projectDirPath,
        reactAppBuildDirPath,
        keycloakThemeBuildingDirPath,
        themeSrcDirPath,
        keycloakifySrcDirPath,
        buildOptions,
        keycloakifyVersion
    } = params;

    const getThemeDirPath = (themeType: ThemeType | "email") =>
        pathJoin(keycloakThemeBuildingDirPath, "src", "main", "resources", "theme", buildOptions.themeName, themeType);

    let allCssGlobalsToDefine: Record<string, string> = {};

    let generateFtlFilesCode_glob: ReturnType<typeof generateFtlFilesCodeFactory>["generateFtlFilesCode"] | undefined = undefined;

    for (const themeType of themeTypes) {
        if (!fs.existsSync(pathJoin(themeSrcDirPath, themeType))) {
            continue;
        }

        const themeDirPath = getThemeDirPath(themeType);

        copy_app_resources_to_theme_path: {
            const isFirstPass = themeType.indexOf(themeType) === 0;

            if (!isFirstPass) {
                break copy_app_resources_to_theme_path;
            }

            transformCodebase({
                "destDirPath": pathJoin(themeDirPath, "resources", "build"),
                "srcDirPath": reactAppBuildDirPath,
                "transformSourceCode": ({ filePath, sourceCode }) => {
                    //NOTE: Prevent cycles, excludes the folder we generated for debug in public/
                    if (
                        isInside({
                            "dirPath": pathJoin(reactAppBuildDirPath, keycloak_resources),
                            filePath
                        })
                    ) {
                        return undefined;
                    }

                    if (/\.css?$/i.test(filePath)) {
                        const { cssGlobalsToDefine, fixedCssCode } = replaceImportsInCssCode({
                            "cssCode": sourceCode.toString("utf8")
                        });

                        register_css_variables: {
                            if (!isFirstPass) {
                                break register_css_variables;
                            }

                            allCssGlobalsToDefine = {
                                ...allCssGlobalsToDefine,
                                ...cssGlobalsToDefine
                            };
                        }

                        return { "modifiedSourceCode": Buffer.from(fixedCssCode, "utf8") };
                    }

                    if (/\.js?$/i.test(filePath)) {
                        const { fixedJsCode } = replaceImportsFromStaticInJsCode({
                            "jsCode": sourceCode.toString("utf8")
                        });

                        return { "modifiedSourceCode": Buffer.from(fixedJsCode, "utf8") };
                    }

                    return { "modifiedSourceCode": sourceCode };
                }
            });
        }

        const generateFtlFilesCode =
            generateFtlFilesCode_glob !== undefined
                ? generateFtlFilesCode_glob
                : generateFtlFilesCodeFactory({
                      "indexHtmlCode": fs.readFileSync(pathJoin(reactAppBuildDirPath, "index.html")).toString("utf8"),
                      "cssGlobalsToDefine": allCssGlobalsToDefine,
                      buildOptions,
                      keycloakifyVersion,
                      themeType,
                      "fieldNames": readFieldNameUsage({
                          keycloakifySrcDirPath,
                          themeSrcDirPath,
                          themeType
                      })
                  }).generateFtlFilesCode;

        [
            ...(() => {
                switch (themeType) {
                    case "login":
                        return loginThemePageIds;
                    case "account":
                        return accountThemePageIds;
                }
            })(),
            ...readExtraPagesNames({
                themeType,
                themeSrcDirPath
            })
        ].forEach(pageId => {
            const { ftlCode } = generateFtlFilesCode({ pageId });

            fs.mkdirSync(themeDirPath, { "recursive": true });

            fs.writeFileSync(pathJoin(themeDirPath, pageId), Buffer.from(ftlCode, "utf8"));
        });

        generateMessageProperties({
            themeSrcDirPath,
            themeType
        }).forEach(({ languageTag, propertiesFileSource }) => {
            const messagesDirPath = pathJoin(themeDirPath, "messages");

            fs.mkdirSync(pathJoin(themeDirPath, "messages"), { "recursive": true });

            const propertiesFilePath = pathJoin(messagesDirPath, `messages_${languageTag}.properties`);

            fs.writeFileSync(propertiesFilePath, Buffer.from(propertiesFileSource, "utf8"));
        });

        await downloadKeycloakStaticResources({
            projectDirPath,
            "keycloakVersion": (() => {
                switch (themeType) {
                    case "account":
                        return lastKeycloakVersionWithAccountV1;
                    case "login":
                        return buildOptions.loginThemeDefaultResourcesFromKeycloakVersion;
                }
            })(),
            themeDirPath,
            themeType,
            "usedResources": readStaticResourcesUsage({
                keycloakifySrcDirPath,
                themeSrcDirPath,
                themeType
            })
        });

        fs.writeFileSync(
            pathJoin(themeDirPath, "theme.properties"),
            Buffer.from(
                [
                    `parent=${(() => {
                        switch (themeType) {
                            case "account":
                                return "account-v1";
                            case "login":
                                return "keycloak";
                        }
                        assert<Equals<typeof themeType, never>>(false);
                    })()}`,
                    ...(buildOptions.extraThemeProperties ?? [])
                ].join("\n\n"),
                "utf8"
            )
        );
    }

    email: {
        const emailThemeSrcDirPath = pathJoin(themeSrcDirPath, "email");

        if (!fs.existsSync(emailThemeSrcDirPath)) {
            break email;
        }

        transformCodebase({
            "srcDirPath": emailThemeSrcDirPath,
            "destDirPath": getThemeDirPath("email")
        });
    }
}
