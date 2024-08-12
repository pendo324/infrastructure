import * as cdk from 'aws-cdk-lib';
import { aws_autoscaling as autoscaling } from 'aws-cdk-lib';
import { UpdatePolicy } from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as resourcegroups from 'aws-cdk-lib/aws-resourcegroups';
import { Construct } from 'constructs';
import { readFileSync } from 'fs';
import { PlatformType, RunnerType } from '../config/runner-config';
import { applyTerminationProtectionOnStacks } from './aspects/stack-termination-protection';
import { ENVIRONMENT_STAGE } from './finch-pipeline-app-stage';

interface ASGRunnerStackProps extends cdk.StackProps {
  env: cdk.Environment | undefined;
  stage: ENVIRONMENT_STAGE;
  licenseArn?: string;
  type: RunnerType;
}

const userData = (props: ASGRunnerStackProps, setupScriptName: string) =>
  `#!/bin/bash
LABEL_STAGE=${props.stage === ENVIRONMENT_STAGE.Release ? 'release' : 'test'}
REPO=${props.type.repo}
REGION=${props.env?.region}
` + readFileSync(`./scripts/${setupScriptName}`, 'utf8');

/**
 * A stack to provision an autoscaling group for macOS instances. This requires:
 *  - a self-managed license (manually created as cdk/cfn does not support this)
 *  - a resource group
 *  - a launch template
 *  - an auto scaling group
 */
export class ASGRunnerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ASGRunnerStackProps) {
    super(scope, id, props);
    applyTerminationProtectionOnStacks([this]);

    const platform = props.type.platform;
    const version = props.type.version;
    const arch = props.type.arch;

    const amiSearchString = `amzn-ec2-macos-${version}*`;

    let instanceType = '';
    let machineImage: ec2.IMachineImage;
    let userDataString = '';
    let asgName = '';
    switch (platform) {
      case PlatformType.MAC: {
        if (arch === 'arm') {
          instanceType = 'mac2.metal';
        } else {
          instanceType = 'mac1.metal';
        }
        const macOSArchLookup = arch === 'arm' ? `arm64_${platform}` : `x86_64_${platform}`;
        machineImage = new ec2.LookupMachineImage({
          name: amiSearchString,
          filters: {
            'virtualization-type': ['hvm'],
            'root-device-type': ['ebs'],
            architecture: [macOSArchLookup],
            'owner-alias': ['amazon']
          }
        });
        asgName = 'MacASG';
        userDataString = userData(props, 'setup-runner.sh');
      }
      case PlatformType.WINDOWS: {
        instanceType = 'm5zn.metal';
        asgName = 'WindowsASG';
        machineImage = ec2.MachineImage.latestWindows(ec2.WindowsVersion.WINDOWS_SERVER_2022_ENGLISH_FULL_BASE);
        // We need to provide user data as a yaml file to specify runAs: admin
        // Maintain that file as yaml and source here to ensure formatting.
        userDataString = readFileSync('./scripts/windows-runner-user-data.yaml', 'utf8')
          .replace('<STAGE>', props.stage === ENVIRONMENT_STAGE.Release ? 'release' : 'test')
          .replace('<REPO>', props.type.repo)
          .replace('<REGION>', props.env?.region || '');
      }
      default: {
        // Linux instances do not have to be metal, since the only mode of operation
        // for Finch on linux currently is "native" mode, e.g. no virutal machine on host
        instanceType = arch === 'arm' ? 'c7g.large' : 'c7a.large';
        asgName = 'LinuxASG';
        userDataString = userData(props, 'setup-linux-runner.sh');
        if (platform === PlatformType.AMAZONLINUX) {
          if (version === '2') {
            machineImage = ec2.MachineImage.latestAmazonLinux2();
          } else {
            machineImage = ec2.MachineImage.latestAmazonLinux2023();
          }
        } else {
          machineImage = ec2.MachineImage.genericLinux(
            // from https://fedoraproject.org/cloud/download#cloud_launch
            {
              'us-east-2': arch === 'arm' ? 'ami-02f1e969ae0fdff65' : 'ami-097f74237291abc07',
              'us-east-1': arch === 'arm' ? 'ami-0d3825b70fa928886' : 'ami-004f552bba0e5f64f'
            }
          );
        }
      }
    }

    if (props.env == undefined) {
      throw new Error('Runner environment is undefined!');
    }

    const vpc = cdk.aws_ec2.Vpc.fromLookup(this, 'VPC', { isDefault: true });

    const securityGroup = new ec2.SecurityGroup(this, 'EC2SecurityGroup', {
      vpc,
      description: 'Allow only outbound traffic',
      allowAllOutbound: true
    });

    const role = new iam.Role(this, 'EC2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com')
    });

    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AutoScalingFullAccess'));
    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('ResourceGroupsandTagEditorFullAccess'));

    // Grant EC2 instances access to secretsmanager to retrieve the GitHub api key to register runners
    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'secretsmanager:GetResourcePolicy',
          'secretsmanager:GetSecretValue',
          'secretsmanager:DescribeSecret',
          'secretsmanager:ListSecretVersionIds'
        ],
        resources: [
          `arn:aws:secretsmanager:${props.env?.region}:${props.env?.account}:secret:${props.type.repo}-runner-reg-key*`
        ]
      })
    );

    // Create a custom name for this as names for resource groups cannot be repeated
    const resourceGroupName = `${props.type.repo}-${platform}-${version.split('.')[0]}-${props.type.arch}HostGroup`;

    const resourceGroup = new resourcegroups.CfnGroup(this, resourceGroupName, {
      name: resourceGroupName,
      description: 'Host resource group for finchs infrastructure',
      configuration: [
        {
          type: 'AWS::EC2::HostManagement',
          parameters: [
            {
              name: 'auto-allocate-host',
              values: ['true']
            },
            {
              name: 'auto-release-host',
              values: ['true']
            },
            {
              name: 'any-host-based-license-configuration',
              values: ['true']
            }
          ]
        },
        {
          type: 'AWS::ResourceGroups::Generic',
          parameters: [
            {
              name: 'allowed-resource-types',
              values: ['AWS::EC2::Host']
            },
            {
              name: 'deletion-protection',
              values: ['UNLESS_EMPTY']
            }
          ]
        }
      ]
    });

    // Create a 100GiB volume to be used as instance root volume
    const rootVolume: ec2.BlockDevice = {
      deviceName: '/dev/sda1',
      volume: ec2.BlockDeviceVolume.ebs(100)
    };

    const ltName = `${asgName}LaunchTemplate`;
    const keyPairName = `${asgName}KeyPair`;
    const lt = new ec2.LaunchTemplate(this, ltName, {
      requireImdsv2: true,
      instanceType: new ec2.InstanceType(instanceType),
      keyPair: ec2.KeyPair.fromKeyPairName(this, keyPairName, 'runner-key'),
      machineImage,
      role: role,
      securityGroup: securityGroup,
      userData: ec2.UserData.custom(userDataString),
      blockDevices: [rootVolume]
    });

    // Escape hatch to cfnLaunchTemplate as the L2 construct lacked some required
    // configurations.
    const cfnLt = lt.node.defaultChild as ec2.CfnLaunchTemplate;
    cfnLt.launchTemplateData = {
      ...cfnLt.launchTemplateData,
      placement: {
        tenancy: 'host',
        hostResourceGroupArn: resourceGroup.attrArn
      },
      tagSpecifications: [
        {
          resourceType: 'instance',
          tags: [
            {
              key: 'PVRE-Reporting',
              value: 'SSM'
            }
          ]
        }
      ],
      ...(props.licenseArn && {
        licenseSpecifications: [{ licenseConfigurationArn: props.licenseArn }]
      })
    };

    const asg = new autoscaling.AutoScalingGroup(this, asgName, {
      vpc,
      desiredCapacity: props.type.desiredInstances,
      maxCapacity: props.type.desiredInstances,
      minCapacity: 0,
      healthCheck: autoscaling.HealthCheck.ec2({
        grace: cdk.Duration.seconds(3600)
      }),
      launchTemplate: lt,
      updatePolicy: UpdatePolicy.rollingUpdate({
        // Defaults shown here explicitly except for pauseTime
        // and minSuccesPercentage
        maxBatchSize: 1,
        minInstancesInService: 0,
        suspendProcesses: [
          autoscaling.ScalingProcess.HEALTH_CHECK,
          autoscaling.ScalingProcess.REPLACE_UNHEALTHY,
          autoscaling.ScalingProcess.AZ_REBALANCE,
          autoscaling.ScalingProcess.ALARM_NOTIFICATION,
          autoscaling.ScalingProcess.SCHEDULED_ACTIONS
        ],
        waitOnResourceSignals: false
      })
    });

    if (props.stage === ENVIRONMENT_STAGE.Beta) {
      new autoscaling.CfnScheduledAction(this, 'SpinDownBetaInstances', {
        autoScalingGroupName: asg.autoScalingGroupName,
        // 1 day from now
        startTime: new Date(new Date().getTime() + 1 * 24 * 60 * 60 * 1000).toISOString(),
        desiredCapacity: 0
      });
    }
  }
}
