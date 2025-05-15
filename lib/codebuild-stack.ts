import { Environment, Stack, CfnResource } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { GITHUB_ALLOWLISTED_ACCOUNT_IDS } from './constants';
import { Construct } from 'constructs';
import { Key } from 'aws-cdk-lib/aws-kms';
import { toStackName } from './utils';

const webhookFiltersArr: codebuild.FilterGroup[] = [];

for (const userId of GITHUB_ALLOWLISTED_ACCOUNT_IDS) {
    console.log('creating filter group for userid: ', userId);
    webhookFiltersArr.push(codebuild.FilterGroup.inEventOf(codebuild.EventAction.WORKFLOW_JOB_QUEUED).andActorAccountIs(userId));
}

const githHubSource = codebuild.Source.gitHub({
    owner: 'runfinch',
    repo: 'finch',
    webhook: true,
    webhookFilters: webhookFiltersArr,
});

/**
 * Default properties for CodeBuildStack configuration.
 * Contains static readonly properties that define default values for image filters,
 * fleet configuration, and project environment settings.
 */
export class CodeBuildStackDefaultProps {
    static readonly imageFilterProps = {
      virtualizationType: ['hvm'],
      rootDeviceType: ['ebs'],
      ownerAlias: ['amazon'],
    };
    static readonly fleetProps = {
        computeType: codebuild.FleetComputeType.MEDIUM,
        baseCapacity: 1,
    };
    static readonly projectEnvironmentProps = {
        computeType: codebuild.ComputeType.MEDIUM,
        privileged: true,
    };
}

export class CodeBuildStackProps {
    env: Environment | undefined;
    projectName: string;
    region: string;
    arch: string;
    amiSearchString: string;
    buildImage: codebuild.IBuildImage;
    environmentType: codebuild.EnvironmentType;
    imageFilterProps?: {
        virtualizationType: string[],
        rootDeviceType: string[],
        ownerAlias: string[],
    };
    fleetProps?: {
        computeType: codebuild.FleetComputeType,
        baseCapacity: number,
    };
    projectEnvironmentProps?: {
        computeType: codebuild.ComputeType,
        privileged: boolean,
    };
}

export class CodeBuildStack extends Stack {
    constructor(scope: Construct, id: string, props: CodeBuildStackProps) {
        super(scope, id, props);
        this.createBuildProject(props, id);
    }

    private createBuildProject(props: CodeBuildStackProps, id: string): codebuild.Project {
        const machineImage = new ec2.LookupMachineImage({
            name: props.amiSearchString,
            filters: {
                ...(props.imageFilterProps || CodeBuildStackDefaultProps.imageFilterProps),
                'architecture': [props.arch],
            }
        });

        const fleet = new codebuild.Fleet(this, `Fleet-${toStackName(props.arch)}`, {
            ...(props.fleetProps || CodeBuildStackDefaultProps.fleetProps),
            environmentType: props.environmentType,
        });

        const cfnFleet = fleet.node.defaultChild as CfnResource;
        cfnFleet.addPropertyOverride('ImageId', machineImage.getImage(this).imageId);
    
        return new codebuild.Project(this, id, {
            projectName: props.projectName,
            source: githHubSource,
            environment: {
                ...(props.projectEnvironmentProps || CodeBuildStackDefaultProps.projectEnvironmentProps),
                fleet: fleet,
                buildImage: props.buildImage,
            },
            encryptionKey: new Key(this, `codebuild-${toStackName(props.arch)}-key-${props.region}`, {
                description: 'Kms Key to encrypt data-at-rest',
                alias: `finch-${props.arch}-kms-${props.region}`,
            })
        });
    }
}
