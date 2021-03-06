import { int2Asm, bsv, arrayTypeAndSize, genLaunchConfigFile, getStructNameByType, isArrayType, isStructType, checkArray, flatternArray, typeOfArg, subscript, flatternStruct, resolveType, int2Value, asm2int, createStruct, createArray, asm2ScryptType } from './utils';
import { AbstractContract, TxContext, VerifyResult, AsmVarValues, buildTypeResolver } from './contract';
import { ScryptType, Bool, Int, SingletonParamType, SupportedParamType, Struct, Bytes } from './scryptTypes';
import { ABIEntityType, ABIEntity, ParamEntity, AliasEntity } from './compilerWrapper';

export interface Script {
  toASM(): string;
  toHex(): string;
}

export type FileUri = string;

/**
     * Configuration for a debug session.
     */
export interface DebugConfiguration {
  type: 'scrypt';
  request: 'launch';
  internalConsoleOptions: 'openOnSessionStart',
  name: string;
  program: string;
  constructorArgs: SupportedParamType[];
  pubFunc: string;
  pubFuncArgs: SupportedParamType[];
  asmArgs?: AsmVarValues;
  txContext?: any;
}

export interface DebugLaunch {
  version: '0.2.0';
  configurations: DebugConfiguration[];
}

function escapeRegExp(stringToGoIntoTheRegex) {
  return stringToGoIntoTheRegex.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

export interface Argument {
  name: string,
  type: string,
  value: SupportedParamType
}

export type Arguments = Argument[];


export class FunctionCall {

  readonly contract: AbstractContract;

  readonly args: Arguments = [];

  private _unlockingScriptAsm?: string;

  private _lockingScriptAsm?: string;

  get unlockingScript(): Script | undefined {
    return this._unlockingScriptAsm === undefined ? undefined : bsv.Script.fromASM(this._unlockingScriptAsm);
  }

  get lockingScript(): Script | undefined {
    return this._lockingScriptAsm === undefined ? undefined : bsv.Script.fromASM(this._lockingScriptAsm);
  }

  init(asmVarValues: AsmVarValues): void {
    for (const key in asmVarValues) {
      const val = asmVarValues[key];
      const re = new RegExp(`\\$${key}`, 'g');
      this._lockingScriptAsm = this._lockingScriptAsm.replace(re, val);
    }
  }

  constructor(
    public methodName: string,
    public params: SupportedParamType[],
    binding: {
      contract: AbstractContract;
      lockingScriptASM?: string;
      unlockingScriptASM?: string;
    }
  ) {

    if (binding.lockingScriptASM === undefined && binding.unlockingScriptASM === undefined) {
      throw new Error('param binding.lockingScriptASM & binding.unlockingScriptASM cannot both be empty');
    }

    this.contract = binding.contract;


    this.args = Object.getPrototypeOf(this.contract).constructor.abi.filter((entity: ABIEntity) => {
      if ('constructor' === methodName) {
        return entity.type === 'constructor';
      }
      return entity.name === methodName;
    }).map((entity: ABIEntity) => {
      return entity.params.map((param, index) => {
        return {
          name: param.name,
          type: param.type,
          value: params[index]
        };
      });
    }).flat(1);

    if (binding.lockingScriptASM) {
      this._lockingScriptAsm = binding.lockingScriptASM;
    }

    if (binding.unlockingScriptASM) {
      this._unlockingScriptAsm = binding.unlockingScriptASM;
    }
  }

  toASM(): string {
    if (this.lockingScript) {
      return this.lockingScript.toASM();
    } else {
      return this.unlockingScript.toASM();
    }
  }

  toString(): string {
    return this.toHex();
  }

  toScript(): Script {
    return bsv.Script.fromASM(this.toASM());
  }

  toHex(): string {
    return this.toScript().toHex();
  }



  genLaunchConfigFile(txContext?: TxContext): FileUri {

    const constructorArgs: SupportedParamType[] = this.contract.scriptedConstructor.params;

    const pubFuncArgs: SupportedParamType[] = this.params;
    const pubFunc: string = this.methodName;
    const name = `Debug ${Object.getPrototypeOf(this.contract).constructor.contractName}`;
    const program = `${Object.getPrototypeOf(this.contract).constructor.file}`;

    const asmArgs: AsmVarValues = this.contract.asmArgs || {};
    const dataPart: string = this.contract.dataPart ? this.contract.dataPart.toASM() : undefined;
    const txCtx: TxContext = Object.assign({}, this.contract.txContext || {}, txContext || {}, { opReturn: dataPart });

    return genLaunchConfigFile(constructorArgs, pubFuncArgs, pubFunc, name, program, txCtx, asmArgs);
  }

  verify(txContext?: TxContext): VerifyResult {
    if (this.unlockingScript) {
      const result = this.contract.run_verify(this.unlockingScript.toASM(), txContext, this.args);

      if (!result.success) {
        const debugUrl = this.genLaunchConfigFile(txContext);
        if (debugUrl) {
          result.error = result.error + `\t[Launch Debugger](${debugUrl.replace(/file:/i, 'scryptlaunch:')})\n`;
        }
      }
      return result;
    }

    return {
      success: false,
      error: 'verification failed, missing unlockingScript'
    };
  }

}

export class ABICoder {

  constructor(public abi: ABIEntity[], public alias: AliasEntity[]) { }


  encodeConstructorCall(contract: AbstractContract, asmTemplate: string, ...args: SupportedParamType[]): FunctionCall {

    const constructorABI = this.abi.filter(entity => entity.type === ABIEntityType.CONSTRUCTOR)[0];
    const cParams = constructorABI?.params || [];

    if (args.length !== cParams.length) {
      throw new Error(`wrong number of arguments for #constructor, expected ${cParams.length} but got ${args.length}`);
    }

    // handle array type
    const cParams_: Array<ParamEntity> = [];
    const args_: SupportedParamType[] = [];
    cParams.forEach((param, index) => {
      const arg = args[index];
      const finalType = resolveType(this.alias, param.type);
      if (isArrayType(finalType)) {
        const [elemTypeName, arraySizes] = arrayTypeAndSize(finalType);

        if (Array.isArray(arg)) {
          if (checkArray(arg, [elemTypeName, arraySizes])) {
            // flattern array
            flatternArray(arg, param.name, finalType).forEach((e, idx) => {
              cParams_.push({ name: e.name, type: e.type });
              args_.push(e.value);
            });
          } else {
            throw new Error(`constructor ${index}-th parameter should be ${finalType}`);
          }
        } else {
          throw new Error(`constructor ${index}-th parameter should be ${finalType}`);
        }
      } else if (isStructType(finalType)) {

        const argS = arg as Struct;

        if (finalType != argS.finalType) {
          throw new Error(`expect struct ${param.type} but got struct ${argS.type}`);
        }

        flatternStruct(argS, param.name).forEach(v => {
          cParams_.push({ name: `${v.name}`, type: v.type });
          args_.push(v.value);
        });
      }
      else {
        cParams_.push(param);
        args_.push(arg);
      }
    });

    let lsASM = asmTemplate;

    cParams_.forEach((param, index) => {
      if (!asmTemplate.includes(`$${param.name}`)) {
        throw new Error(`abi constructor params mismatch with args provided: missing ${param.name} in ASM tempalte`);
      }

      const re = param.name.endsWith(']') ? new RegExp(`\\B${escapeRegExp(`$${param.name}`)}\\B`, 'g') : new RegExp(`\\B${escapeRegExp(`$${param.name}`)}\\b`, 'g');
      lsASM = lsASM.replace(re, this.encodeParam(args_[index], param));
    });

    return new FunctionCall('constructor', args, { contract, lockingScriptASM: lsASM });
  }

  encodeConstructorCallFromASM(contract: AbstractContract, asmTemplate: string, lsASM: string): FunctionCall {
    const constructorABI = this.abi.filter(entity => entity.type === ABIEntityType.CONSTRUCTOR)[0];
    const cParams = constructorABI?.params || [];
    const contractName = Object.getPrototypeOf(contract).constructor.contractName;
    const opcodesMap = new Map<string, string>();

    const asmTemplateOpcodes = asmTemplate.split(' ');
    const asmOpcodes = lsASM.split(' ');


    if (asmTemplateOpcodes.length > asmOpcodes.length) {
      throw new Error(`the raw script cannot match the asm template of contract ${contractName}`);
    }

    asmTemplateOpcodes.forEach((opcode, index) => {

      if (opcode.startsWith('$')) {
        opcodesMap.set(opcode, asmOpcodes[index]);
      } else if (bsv.Script.fromASM(opcode).toHex() !== bsv.Script.fromASM(asmOpcodes[index]).toHex()) {
        throw new Error(`the raw script cannot match the asm template of contract ${contractName}`);
      }
    });

    if (asmTemplateOpcodes.length < asmOpcodes.length) {
      const opcode = asmOpcodes[asmTemplateOpcodes.length];
      if (opcode !== 'OP_RETURN') {
        throw new Error(`the raw script cannot match the asm template of contract ${contractName}`);
      }
    }


    const finalTypeResolver = buildTypeResolver(this.alias);

    const args: SupportedParamType[] = [];
    cParams.forEach((param, index) => {
      const finalType = finalTypeResolver(param.type);


      if (isStructType(finalType)) {

        const stclass = contract.getTypeClassByType(param.type);

        args.push(createStruct(contract, stclass as typeof Struct, param.name, opcodesMap, finalTypeResolver));
      } else if (isArrayType(finalType)) {

        args.push(createArray(contract, finalType, param.name, opcodesMap, finalTypeResolver));

      } else {
        args.push(asm2ScryptType(finalType, opcodesMap.get(`$${param.name}`)));
      }

    });


    return new FunctionCall('constructor', args, { contract, lockingScriptASM: lsASM });
  }

  encodePubFunctionCall(contract: AbstractContract, name: string, args: SupportedParamType[]): FunctionCall {

    for (const entity of this.abi) {
      if (entity.name === name) {
        if (entity.params.length !== args.length) {
          throw new Error(`wrong number of arguments for #${name}, expected ${entity.params.length} but got ${args.length}`);
        }
        let asm = this.encodeParams(args, entity.params);
        if (this.abi.length > 2 && entity.index !== undefined) {
          // selector when there are multiple public functions
          const pubFuncIndex = entity.index;
          asm += ` ${int2Asm(pubFuncIndex.toString())}`;
        }
        return new FunctionCall(name, args, { contract, unlockingScriptASM: asm });
      }
    }

    throw new Error(`no function named '${name}' found in abi`);
  }

  encodeParams(args: SupportedParamType[], paramsEntitys: ParamEntity[]): string {
    return args.map((arg, i) => this.encodeParam(arg, paramsEntitys[i])).join(' ');
  }

  encodeParamArray(args: SingletonParamType[], arrayParm: ParamEntity): string {
    if (args.length === 0) {
      throw new Error('Empty array not allowed');
    }

    const t = typeof args[0];

    if (!args.every(arg => typeof arg === t)) {
      throw new Error('Array arguments are not of the same type');
    }
    const finalType = resolveType(this.alias, arrayParm.type);

    const [elemTypeName, arraySizes] = arrayTypeAndSize(finalType);
    if (checkArray(args, [elemTypeName, arraySizes])) {
      return flatternArray(args, arrayParm.name, finalType).map(arg => {
        return this.encodeParam(arg.value, { name: arg.name, type: arg.type });
      }).join(' ');
    } else {
      throw new Error(`checkArray ${arrayParm.type} fail`);
    }
  }


  encodeParam(arg: SupportedParamType, paramEntity: ParamEntity): string {

    const finalType = resolveType(this.alias, paramEntity.type);
    if (isArrayType(finalType)) {
      if (Array.isArray(arg)) {
        return this.encodeParamArray(arg, paramEntity);
      } else {
        const scryptType = typeOfArg(arg);
        throw new Error(`expect param ${paramEntity.name} as ${finalType} but got ${scryptType}`);
      }
    }

    if (isStructType(finalType)) {

      if (Struct.isStruct(arg)) {
        const argS = arg as Struct;
        if (finalType != argS.finalType) {
          throw new Error(`expect struct ${paramEntity.type} but got struct ${argS.type}`);
        }
      } else {
        const scryptType = (arg as ScryptType).type;
        throw new Error(`expect param ${paramEntity.name} as struct ${getStructNameByType(paramEntity.type)} but got ${scryptType}`);
      }
    }


    const scryptType = typeOfArg(arg);
    if (scryptType != finalType) {
      throw new Error(`wrong argument type, expected ${finalType} or ${paramEntity.type} but got ${scryptType}`);
    }

    const typeofArg = typeof arg;

    if (typeofArg === 'boolean') {
      arg = new Bool(arg as boolean);
    }

    if (typeofArg === 'number') {
      arg = new Int(arg as number);
    }

    if (typeofArg === 'bigint') {
      arg = new Int(arg as bigint);
    }

    if (typeof arg === 'string') {
      arg = new Int(arg as string);
    }

    return (arg as ScryptType).toASM();
  }

}