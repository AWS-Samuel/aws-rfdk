/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'path';
import {
  AutoScalingGroup,
  BlockDeviceVolume,
  CfnAutoScalingGroup,
  HealthCheck,
} from '@aws-cdk/aws-autoscaling';
import {IMetric, Metric} from '@aws-cdk/aws-cloudwatch';
import {
  Connections,
  IConnectable,
  IMachineImage,
  InstanceClass,
  InstanceSize,
  InstanceType,
  ISecurityGroup,
  IVpc,
  SubnetSelection,
  SubnetType,
} from '@aws-cdk/aws-ec2';
import {IApplicationLoadBalancerTarget} from '@aws-cdk/aws-elasticloadbalancingv2';
import {
  IGrantable,
  IPolicy,
  IPrincipal,
  IRole,
  Policy,
  PolicyStatement,
} from '@aws-cdk/aws-iam';
import {
  Construct,
  Duration,
  IResource,
  Size,
  SizeRoundingBehavior,
  Stack,
} from '@aws-cdk/core';
import {
  CloudWatchAgent,
  CloudWatchConfigBuilder,
  HealthCheckConfig,
  HealthMonitor,
  IHealthMonitor,
  IMonitorableFleet,
  LogGroupFactory,
  LogGroupFactoryProps,
  ScriptAsset,
} from '../../core';
import {IRenderQueue} from './render-queue';

/**
 * Interface for Deadline Worker Fleet.
 */
export interface IWorkerFleet extends IResource, IConnectable, IGrantable {
}

/**
 * Properties for the Deadline Worker Fleet.
 */
export interface WorkerFleetProps {
  /**
   * VPC to launch the worker fleet in.
   */
  readonly vpc: IVpc;

  /**
   * Security Group to assign to this fleet.
   *
   * @default - create new security group
   */
  readonly securityGroup?: ISecurityGroup;

  /**
   * An IAM role to associate with the instance profile assigned to its resources.
   *
   * The role must be assumable by the service principal `ec2.amazonaws.com`:
   *
   * @example
   *
   *    const role = new iam.Role(this, 'MyRole', {
   *      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com')
   *    });
   *
   * @default - A role will automatically be created, it can be accessed via the `role` property
   */
  readonly role?: IRole;

  /**
   * AMI of the deadline worker to launch.
   */
  readonly workerMachineImage: IMachineImage;

  /**
   * Type of instance to launch for executing repository installer.
   *
   * @default - a T2-Large type will be used.
   */
  readonly instanceType?: InstanceType;

  /**
   * Where to place the instance within the VPC.
   *
   * @default - Private subnets.
   */
  readonly vpcSubnets?: SubnetSelection;

  /**
   * Name of SSH keypair to grant access to instance.
   *
   * @default - No SSH access will be possible.
   */
  readonly keyName?: string;

  /**
   * Initial amount of workers in the fleet.
   *
   * If this is set to a number, every deployment will reset the amount of
   * workers to this number. It is recommended to leave this value blank.
   *
   * @default minCapacity, and leave unchanged during deployment
   */
  readonly desiredCapacity?: number;

  /**
   * Minimum number of instances in the fleet.
   *
   * @default 1
   */
  readonly minCapacity?: number;

  /**
   * Maximum number of instances in the fleet.
   *
   * @default desiredCapacity, or minCapacity if desiredCapacity is not set
   */
  readonly maxCapacity?: number;

  /**
   * Endpoint for the RenderQueue, to which the worker fleet needs to be connected.
   */
  readonly renderQueue: IRenderQueue;

  /**
   * Deadline groups these workers needs to be assigned to. The group is
   * created if it does not already exist.
   *
   * @default - Worker is not assigned to any group
   */
  readonly groups?: string[];

  /**
   * Deadline pools these workers needs to be assigned to. The pool is created
   * if it does not already exist.
   *
   * @default - Worker is not assigned to any pool.
   */
  readonly pools?: string[];

  /**
   * Deadline region these workers needs to be assigned to.
   *
   * @default - Worker is not assigned to any region
   */
  readonly region?: string;

  /**
   * Properties for setting up the Deadline Worker's LogGroup
   * @default - LogGroup will be created with all properties' default values and a prefix of "deadline".
   */
  readonly logGroupProps?: LogGroupFactoryProps;

  /**
   * Health Monitor component to monitor the health of instances.
   *
   * @default - Health Monitoring is turned-off
   */
  readonly healthMonitor?: IHealthMonitor;

  /**
   * Properties for configuring a health check
   *
   * @default properties of HealthCheckConfig applies
   */
  readonly healthCheckConfig?: HealthCheckConfig;

  /**
   * The maximum hourly price($) to be paid for each Spot instance.
   * min - 0.001; max - 255
   *
   * @default - launches on-demand EC2 instances.
   */
  readonly spotPrice?: number;

  /*
   * The block device volume size, in Gibibytes (GiB)
   *
   * @default 50 GiB
   */
  readonly blockDeviceVolumeSize?: Size
}

/**
 *  A new or imported Deadline Worker Fleet.
 */
abstract class WorkerFleetBase extends Construct implements IWorkerFleet, IMonitorableFleet {

  /**
   * The security groups/rules used to allow network connections to the file system.
   */
  public abstract readonly connections: Connections;

  /**
   * The principal to grant permissions to.
   */
  public abstract readonly grantPrincipal: IPrincipal;

  /**
   * The stack in which this worker fleet is defined.
   */
  public abstract readonly stack: Stack;

  /**
   * The ASG object created by the construct.
   */
  public abstract readonly fleet: AutoScalingGroup;

  /**
   * This field expects the base capacity metric of the fleet against
   * which, the healthy percent will be calculated.
   *
   * eg.: GroupDesiredCapacity for an ASG
   */
  public abstract readonly targetCapacityMetric: IMetric;

  /**
   * This field expects the component of type INetworkLoadBalancerTarget
   * which can be attached to Network Load Balancer for monitoring.
   *
   * eg. An AutoScalingGroup
   */
  public abstract readonly targetToMonitor: IApplicationLoadBalancerTarget;

  /**
   * This field expects a policy which can be attached to the lambda
   * execution role so that it is capable of suspending the fleet.
   *
   * eg.: autoscaling:UpdateAutoScalingGroup permission for an ASG
   */
  public abstract readonly targetUpdatePolicy: IPolicy;

  /**
   * This field expects the maximum instance count this fleet can have.
   */
  public abstract readonly targetCapacity: number;

  /**
   * This field expects the scope in which to create the monitoring resource
   * like TargetGroups, Listener etc.
   */
  public abstract readonly targetScope: Construct;
}

/**
 * This construct reperesents a fleet of Deadline Workers.
 *
 * The construct consists of an Auto Scaling Group (ASG) of instances using a provided AMI which has Deadline and any number
 * of render applications installed.  Whenever an instance in the ASG start it will connect Deadline to the desired render queue.
 *
 * When the worker fleet is deployed if it has been provided a HealthMonitor the Worker fleet will register itself against the Monitor
 * to ensure that the fleet remains healthy.
 *
 * @ResourcesDeployed
 * 1) An AutoScalingGroup to maintain the number of instances;
 * 2) An Instance Role and corresponding IAM Policy;
 * 3) A script asset which is uploaded to your deployment bucket used to configure the worker so it can connect to the Render Queue
 * 4) An aws-rfdk.CloudWatchAgent to configure sending logs to cloudwatch.
 *
 * @ResidualRisk
 * The instance in the AutoScaling group is given a role with the following permissions:
 * - Read permissions to the bucket containing the S3 Assets
 *
 * The Following Security Group changes are made by this construct:
 * - TCP access to the Render Queue's Load Balancer
 */
export class WorkerFleet extends WorkerFleetBase {

  /**
   * The min limit for spot price.
   */
  public static readonly SPOT_PRICE_MIN_LIMIT = 0.001;

  /**
   * The max limit for spot price.
   */
  public static readonly SPOT_PRICE_MAX_LIMIT = 255;

  /**
   * This determines worker's health based on any hardware or software issues of EC2 instance.
   * Resource Tracker does deep ping every 5 minutes. These checks should be more frequent so
   * that any EC2 level issues are identified ASAP. Hence setting it to 1 minute.
   */
  private static DEFAULT_HEALTH_CHECK_INTERVAL = Duration.minutes(1);

  /**
   * Default prefix for a LogGroup if one isn't provided in the props.
   */
  private static readonly DEFAULT_LOG_GROUP_PREFIX: string = 'deadline';

  /**
   * Setting the default signal timeout to 15 min. This is the max time, a single instance is expected
   * to take for launch and execute the user-data for deadline worker configuration. As we are setting
   * failure signals in the user-data, any failure will terminate deployment immediately.
   */
  private static readonly RESOURCE_SIGNAL_TIMEOUT = Duration.minutes(15);

  /**
   * The ASG object created by the construct.
   */
  public readonly fleet: AutoScalingGroup;

  /**
   * The security groups/rules used to allow network connections to the file system.
   */
  public readonly connections: Connections;

  /**
   * The principal to grant permissions to.
   */
  public readonly grantPrincipal: IPrincipal;

  /**
   * The stack in which this worker fleet is defined.
   */
  public readonly stack: Stack;

  /**
   * This field implements the base capacity metric of the fleet against
   * which, the healthy percent will be calculated.
   *
   * eg.: GroupDesiredCapacity for an ASG
   */
  public readonly targetCapacityMetric: IMetric;

  /**
   * This field implements the component of type INetworkLoadBalancerTarget
   * which can be attached to Network Load Balancer for monitoring.
   *
   * eg. An AutoScalingGroup
   */
  public readonly targetToMonitor: IApplicationLoadBalancerTarget;

  /**
   * This field implements a policy which can be attached to the lambda
   * execution role so that it is capable of suspending the fleet.
   *
   * eg.: autoscaling:UpdateAutoScalingGroup permission for an ASG
   */
  public readonly targetUpdatePolicy: IPolicy;

  /**
   * This field implements the maximum instance count this fleet can have.
   */
  public readonly targetCapacity: number;

  /**
   * This field implements the scope in which to create the monitoring resource
   * like TargetGroups, Listener etc.
   */
  public readonly targetScope: Construct;

  constructor(scope: Construct, id: string, props: WorkerFleetProps) {
    super(scope, id);
    this.stack = Stack.of(scope);

    this.validateProps(props);

    // Launching the fleet with deadline workers.
    this.fleet = new AutoScalingGroup(this, 'Default', {
      vpc: props.vpc,
      instanceType: (props.instanceType ? props.instanceType : InstanceType.of(InstanceClass.T2, InstanceSize.LARGE)),
      machineImage: props.workerMachineImage,
      keyName: props.keyName,
      vpcSubnets: props.vpcSubnets ? props.vpcSubnets : {
        subnetType: SubnetType.PRIVATE,
      },
      minCapacity: props.minCapacity,
      maxCapacity: props.maxCapacity,
      desiredCapacity: props.desiredCapacity,
      resourceSignalTimeout: WorkerFleet.RESOURCE_SIGNAL_TIMEOUT,
      healthCheck: HealthCheck.elb({
        grace: WorkerFleet.DEFAULT_HEALTH_CHECK_INTERVAL,
      }),
      role: props.role,
      spotPrice: props.spotPrice?.toString(),
      blockDevices: [ {
        deviceName: '/dev/xvda',
        volume: BlockDeviceVolume.ebs( props.blockDeviceVolumeSize?.toGibibytes({ rounding: SizeRoundingBehavior.FAIL }) ?? 50, {encrypted: true}),
      }],
    });

    this.targetCapacity = parseInt((this.fleet.node.defaultChild as CfnAutoScalingGroup).maxSize, 10);
    this.targetScope = this;
    this.targetToMonitor = this.fleet;
    this.targetCapacityMetric = new Metric({
      namespace: 'AWS/AutoScaling',
      metricName: 'GroupDesiredCapacity',
      dimensions: {
        AutoScalingGroupName: this.fleet.autoScalingGroupName,
      },
      label: 'GroupDesiredCapacity',
    });
    this.targetUpdatePolicy = new Policy(this, 'ASGUpdatePolicy', {
      statements: [new PolicyStatement({
        actions: ['autoscaling:UpdateAutoScalingGroup'],
        resources: [this.fleet.autoScalingGroupArn],
      })],
    });

    (this.fleet.node.defaultChild as CfnAutoScalingGroup).metricsCollection = [{
      granularity: '1Minute',
      metrics: ['GroupDesiredCapacity'],
    }];

    if (props.securityGroup) {
      this.fleet.addSecurityGroup(props.securityGroup);
    }

    this.grantPrincipal = this.fleet.grantPrincipal;
    this.connections = this.fleet.connections;

    this.connections.allowToDefaultPort(props.renderQueue);

    let healthCheckPort = HealthMonitor.DEFAULT_HEALTH_CHECK_PORT;
    if (props.healthCheckConfig && props.healthCheckConfig.port) {
      healthCheckPort = props.healthCheckConfig.port;
    }

    // Configure the health monitoring if provided
    this.configureHealthMonitor(props, healthCheckPort);

    // Updating the user data with installation logs stream.
    this.configureCloudWatchLogStream(this.fleet, id, props.logGroupProps);

    props.renderQueue.configureClientInstance({
      host: this.fleet,
    });

    // Updating the user data with deadline repository installation commands.
    this.configureWorkerScript(this.fleet, props, healthCheckPort);

    // Updating the user data with successful cfn-signal commands.
    this.fleet.userData.addSignalOnExitCommand(this.fleet);
  }

  /**
   * Add the security group to all workers
   *
   * @param securityGroup: The security group to add
   */
  public addSecurityGroup(securityGroup: ISecurityGroup): void {
    this.fleet.addSecurityGroup(securityGroup);
  }

  private configureCloudWatchLogStream(fleetInstance: AutoScalingGroup, id: string, logGroupProps?: LogGroupFactoryProps) {
    const prefix = logGroupProps?.logGroupPrefix ? logGroupProps.logGroupPrefix : WorkerFleet.DEFAULT_LOG_GROUP_PREFIX;
    const defaultedLogGroupProps = {
      ...logGroupProps,
      logGroupPrefix: prefix,
    };
    const logGroup = LogGroupFactory.createOrFetch(this, `${id}LogGroupWrapper`, `${id}`, defaultedLogGroupProps);

    logGroup.grantWrite(fleetInstance);

    const cloudWatchConfigurationBuilder = new CloudWatchConfigBuilder(Duration.seconds(15));

    cloudWatchConfigurationBuilder.addLogsCollectList(logGroup.logGroupName,
      'UserdataExecution',
      'C:\\ProgramData\\Amazon\\EC2-Windows\\Launch\\Log\\UserdataExecution.log');
    cloudWatchConfigurationBuilder.addLogsCollectList(logGroup.logGroupName,
      'WorkerLogs',
      'C:\\ProgramData\\Thinkbox\\Deadline10\\logs\\deadlineslave*.log');
    cloudWatchConfigurationBuilder.addLogsCollectList(logGroup.logGroupName,
      'LauncherLogs',
      'C:\\ProgramData\\Thinkbox\\Deadline10\\logs\\deadlinelauncher*.log');
    cloudWatchConfigurationBuilder.addLogsCollectList(logGroup.logGroupName,
      'cloud-init-output',
      '/var/log/cloud-init-output.log');
    cloudWatchConfigurationBuilder.addLogsCollectList(logGroup.logGroupName,
      'WorkerLogs',
      '/var/log/Thinkbox/Deadline10/deadlineslave*.log');
    cloudWatchConfigurationBuilder.addLogsCollectList(logGroup.logGroupName,
      'LauncherLogs',
      '/var/log/Thinkbox/Deadline10/deadlinelauncher*.log');

    new CloudWatchAgent(this, 'WorkerFleetLogsConfig', {
      cloudWatchConfig: cloudWatchConfigurationBuilder.generateCloudWatchConfiguration(),
      host: fleetInstance,
    });
  }

  private configureWorkerScript(fleetInstance: AutoScalingGroup, props: WorkerFleetProps, healthCheckPort: number) {
    const configureWorkerScriptAsset = ScriptAsset.fromPathConvention(this, 'WorkerConfigurationScript', {
      osType: fleetInstance.osType,
      baseName: 'configureWorker',
      rootDir: path.join(
        __dirname,
        '..',
        'scripts/',
      ),
    });

    // Converting to lower case, as groups and pools are all stored in lower case in deadline.
    const groups = props.groups ? props.groups.map(val => val.toLowerCase()).join(',') : '';
    const pools = props.pools ? props.pools.map(val => val.toLowerCase()).join(',') : '';

    configureWorkerScriptAsset.executeOn({
      host: fleetInstance,
      args: [
        `'${healthCheckPort}'`,
        `'${groups}'`,
        `'${pools}'`,
        `'${props.region || ''}'`,
      ],
    });
  }

  private validateProps(props: WorkerFleetProps) {
    this.validateSpotPrice(props.spotPrice);
    this.validateArrayGroupsPoolsSyntax(props.groups, /^(?!none$)[a-zA-Z0-9-_]+$/i, 'groups');
    this.validateArrayGroupsPoolsSyntax(props.pools, /^(?!none$)[a-zA-Z0-9-_]+$/i, 'pools');
    this.validateRegion(props.region, /^(?!none$|all$|unrecognized$)[a-zA-Z0-9-_]+$/i);
  }

  private validateSpotPrice(spotPrice: number | undefined) {
    if (spotPrice && !(spotPrice >= WorkerFleet.SPOT_PRICE_MIN_LIMIT && spotPrice <= WorkerFleet.SPOT_PRICE_MAX_LIMIT)) {
      throw new Error(`Invalid value: ${spotPrice} for property 'spotPrice'. Valid values can be any decimal between ${WorkerFleet.SPOT_PRICE_MIN_LIMIT} and ${WorkerFleet.SPOT_PRICE_MAX_LIMIT}.`);
    }
  }

  private validateRegion(region: string | undefined, regex: RegExp) {
    if (region && !regex.test(region)) {
      throw new Error(`Invalid value: ${region} for property 'region'. Valid characters are A-Z, a-z, 0-9, - and _. ‘All’, ‘none’ and ‘unrecognized’ are reserved names that cannot be used.`);
    }
  }

  private validateArrayGroupsPoolsSyntax(array: string[] | undefined, regex: RegExp, property: string) {
    if (array) {
      array.forEach(value => {
        if (!regex.test(value)) {
          throw new Error(`Invalid value: ${value} for property '${property}'. Valid characters are A-Z, a-z, 0-9, - and _. Also, group 'none' is reserved as the default group.`);
        }
      });
    }
  }

  private configureHealthMonitor(props: WorkerFleetProps, healthCheckPort: number) {
    if (props.healthMonitor) {
      props.healthMonitor.registerFleet(this, props.healthCheckConfig || {
        port: healthCheckPort,
      });
    } else {
      this.node.addWarning(`The worker-fleet ${this.node.id} is being created without a health monitor attached to it. This means that the fleet will not automatically scale-in to 0 if the workers are unhealthy.`);
    }
  }
}